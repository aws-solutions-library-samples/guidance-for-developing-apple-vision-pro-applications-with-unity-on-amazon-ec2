import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Secret } from 'aws-cdk-lib/aws-ecs';
import { Master } from './construct/jenkins/master';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AgentEC2 } from './construct/jenkins/agent-ec2';
import { AgentMac } from './construct/jenkins/agent-mac';
import { AgentKeyPair } from './construct/jenkins/key-pair';
import { UnityAccelerator } from './construct/unity-accelerator';
import { Size, Stack } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, IVpc, Vpc } from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

interface JenkinsUnityBuildStackProps extends cdk.StackProps {
  /**
   * IP address ranges which you can access Jenkins Web UI from
   */
  readonly allowedCidrs: string[];

  /**
   * the AMI id for EC2 mac instances
   *
   * You can get AMI IDs from this page: https://console.aws.amazon.com/ec2/v2/home#AMICatalog:
   * Ensure that the AWS region matches the stack region
   *
   * @default No Mac instance is provisioned
   */
  readonly macAmiId?: string;

  /**
   * You can optionally pass a VPC to deploy the stack
   *
   * @default VPC is created automatically
   */
  readonly vpc?: IVpc;

  /**
   * ARN of an ACM certificate for Jenkins controller ALB.
   * 
   * @default Traffic is not encrypted (via HTTP)
   */
  readonly certificateArn?: string;
}

export class JenkinsUnityBuildStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: JenkinsUnityBuildStackProps) {
    super(scope, id, props);

    let vpc = props.vpc;
    if (vpc === undefined) {
      vpc = new ec2.Vpc(this, 'Vpc', {
        natGateways: 1,
      });
    }

    // S3 bucket to store logs (e.g. ALB access log or S3 bucket access log)
    const logBucket = new Bucket(this, 'LogBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    // S3 bucket which can be accessed from Jenkins agents
    // you can use it to store artifacts or pass files between stages
    const artifactBucket = new Bucket(this, 'ArtifactBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'artifact-bucket-access-logs',
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    // If you want to use private container registry for Jenkins jobs, use this repository
    // By default it is not used at all.
    const containerRepository = new ecr.Repository(this, 'Repository', {
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // EC2 key pair that Jenkins master uses to connect to Jenkins agents
    const keyPair = new AgentKeyPair(this, 'KeyPair', { keyPairName: `${Stack.of(this).stackName}-agent-ssh-key` });

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      vpc,
      name: 'build',
    });

    const accelerator = new UnityAccelerator(this, 'UnityAccelerator', {
      vpc,
      namespace,
      storageSizeGb: 300,
      // You can explicitly set a subnet that Unity accelerator is deployed at.
      // It can possibly improve the Accelerator performance to use the same Availability zone as the Jenkins agents.
      // subnet: vpc.privateSubnets[0],
    });

    const agentEc2 = new AgentEC2(this, 'JenkinsLinuxAgent', {
      vpc,
      sshKeyName: keyPair.keyPairName,
      artifactBucket,
      rootVolumeSize: Size.gibibytes(30),
      dataVolumeSize: Size.gibibytes(100),
      // You may want to add several instance types to avoid from insufficient Spot capacity.
      instanceTypes: [
        ec2.InstanceType.of(InstanceClass.C5, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.C5A, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.C5N, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.C4, InstanceSize.XLARGE),
      ],
      policyStatements: [
        // policy required to run detachFromAsg job.
        new PolicyStatement({
          actions: ['ec2:DescribeImages', 'autoscaling:DetachInstances'],
          resources: ['*'],
        }),
      ],
      fleetMaxSize: 4,
      // You can explicitly set a subnet agents will run in
      // subnets: [vpc.privateSubnets[0]],
    });

    // agents for small tasks
    const agentEc2Small = new AgentEC2(this, 'JenkinsLinuxAgentSmall', {
      vpc,
      sshKeyName: keyPair.keyPairName,
      rootVolumeSize: Size.gibibytes(20),
      fleetMaxSize: 2,
      instanceTypes: [ec2.InstanceType.of(InstanceClass.T3, InstanceSize.SMALL)],
      policyStatements: [
        // policy required to run createAmi job.
        new PolicyStatement({
          actions: [
            'autoscaling:DescribeAutoScalingGroups',
            'autoscaling:UpdateAutoScalingGroup',
            'ec2:CreateImage',
            'ec2:CreateTags',
            'ec2:DescribeImages',
            'ec2:CreateLaunchTemplateVersion',
            'ec2:RunInstances',
            'ec2:TerminateInstances',
          ],
          resources: ['*'],
        }),
        new PolicyStatement({
          actions: ['iam:PassRole'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'iam:PassedToService': ['ec2.amazonaws.com'],
            },
          },
        }),
      ],
    });

    const macAgents = [];

    if (props.macAmiId != null) {
      // We don't use Auto Scaling Group for Mac instances.
      // You need to define this construct for each instance.
      macAgents.push(
        new AgentMac(this, 'JenkinsMacAgent1', {
          vpc,
          artifactBucket,
          // Some AZs don't support Mac instances and you will see an error on CFn deployment.
          // In that case, please change the index of privateSubnets (e.g. privateSubnets[0])
          subnet: vpc.privateSubnets[1],
          storageSize: Size.gibibytes(200),
          instanceType: 'mac1.metal',
          sshKeyName: keyPair.keyPairName,
          amiId: props.macAmiId,
        }),
      );
    }

    const masterEcs = new Master(this, 'JenkinsMaster', {
      vpc,
      allowedCidrs: props.allowedCidrs,
      logBucket,
      artifactBucket,
      certificateArn: props.certificateArn,
      environmentSecrets: { PRIVATE_KEY: Secret.fromSecretsManager(keyPair.privateKey) },
      environmentVariables: {
        UNITY_ACCELERATOR_URL: accelerator.endpoint,
      },
      containerRepository,
      macAgents: macAgents.map((agent, i) => ({ ipAddress: agent.instanceIpAddress, name: `mac${i}` })),
      linuxAgents: [
        {
          minSize: 1,
          maxSize: agentEc2.fleetMaxSize,
          fleetAsgName: agentEc2.fleetName,
          label: 'linux',
          name: 'linux-fleet',
          launchTemplateId: agentEc2.launchTemplate.launchTemplateId,
        },
        {
          minSize: 1,
          maxSize: agentEc2.fleetMaxSize,
          fleetAsgName: agentEc2Small.fleetName,
          label: 'small',
          name: 'linux-fleet-small',
        },
      ],
    });
    agentEc2.allowSSHFrom(masterEcs.service);
    agentEc2Small.allowSSHFrom(masterEcs.service);
    macAgents.forEach((agent) => agent.allowSSHFrom(masterEcs.service));
  }
}

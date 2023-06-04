import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Secret } from 'aws-cdk-lib/aws-ecs';
import { Controller } from './construct/jenkins/controller';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AgentEC2FleetLinux } from './construct/jenkins/agent-ec2-fleet-linux';
import { AgentEC2FleetWindows } from './construct/jenkins/agent-ec2-fleet-windows';
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
  readonly vpcId?: string;

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

    const vpc =
      props.vpcId == null
        ? new ec2.Vpc(this, 'Vpc', {
            natGateways: 1,
          })
        : ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });

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

    // EC2 key pair that Jenkins controller uses to connect to Jenkins agents
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

    const ec2UserCredentialsIdEnv = 'CREDENTIALS_ID_EC2_USER';
    const ec2UserCredentialsId = 'instance-ssh-key-ec2-user';

    const linuxAgent = new AgentEC2FleetLinux(this, 'JenkinsLinuxAgent', {
      vpc,
      sshKeyName: keyPair.keyPairName,
      credentialsIdEnv: ec2UserCredentialsIdEnv,
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
      name: 'linux-fleet',
      label: 'linux',
      fleetMinSize: 1,
      fleetMaxSize: 4,
      // You can explicitly set a subnet agents will run in
      // subnets: [vpc.privateSubnets[0]],
    });

    // agents for small tasks
    const linuxAgentSmall = new AgentEC2FleetLinux(this, 'JenkinsLinuxAgentSmall', {
      vpc,
      sshKeyName: keyPair.keyPairName,
      credentialsIdEnv: ec2UserCredentialsIdEnv,
      rootVolumeSize: Size.gibibytes(20),
      name: 'linux-fleet-small',
      label: 'small',
      fleetMinSize: 1,
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

    const administratorCredentialsIdEnv = 'CREDENTIALS_ID_ADMINISTRATOR';
    const administratorCredentialsId = 'instance-ssh-key-administrator';

    const windowsAgent = new AgentEC2FleetWindows(this, 'JenkinsWindowsAgent', {
      vpc,
      sshKeyName: keyPair.keyPairName,
      credentialsIdEnv: administratorCredentialsIdEnv,
      artifactBucket,
      rootVolumeSize: Size.gibibytes(50),
      dataVolumeSize: Size.gibibytes(100),
      // You may want to add several instance types to avoid from insufficient Spot capacity.
      instanceTypes: [
        ec2.InstanceType.of(InstanceClass.M6A, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.M5A, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.M5N, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.M5, InstanceSize.XLARGE),
        ec2.InstanceType.of(InstanceClass.M4, InstanceSize.XLARGE),
      ],
      policyStatements: [
        // policy required to run detachFromAsg job.
        new PolicyStatement({
          actions: ['ec2:DescribeImages', 'autoscaling:DetachInstances'],
          resources: ['*'],
        }),
      ],
      name: 'windows-fleet',
      label: 'windows',
      fleetMinSize: 1,
      fleetMaxSize: 4,
      // You can explicitly set a subnet agents will run in
      // subnets: [vpc.privateSubnets[0]],
    });

    const ec2FleetAgents = [
      linuxAgent,
      linuxAgentSmall,
      windowsAgent,
    ];

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
          credentialsIdEnv: ec2UserCredentialsIdEnv,
          amiId: props.macAmiId,
          name: 'mac0',
          label: 'mac',
        }),
      );
    }

    const controllerEcs = new Controller(this, 'JenkinsController', {
      vpc,
      allowedCidrs: props.allowedCidrs,
      logBucket,
      artifactBucket,
      certificateArn: props.certificateArn,
      environmentSecrets: { PRIVATE_KEY: Secret.fromSsmParameter(keyPair.privateKey) },
      environmentVariables: {
        UNITY_ACCELERATOR_URL: accelerator.endpoint,
        [ec2UserCredentialsIdEnv]: ec2UserCredentialsId,
        [administratorCredentialsIdEnv]: administratorCredentialsId,
      },
      containerRepository,
      macAgents: macAgents,
      ec2FleetAgents: ec2FleetAgents,
    });
    ec2FleetAgents.forEach(agent => agent.allowSSHFrom(controllerEcs.service));
    macAgents.forEach((agent) => agent.allowSSHFrom(controllerEcs.service));
  }
}

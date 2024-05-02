import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Secret } from 'aws-cdk-lib/aws-ecs';
import { Controller } from './construct/jenkins/controller';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AgentEC2Fleet } from './construct/jenkins/agent-ec2-fleet';
import { AgentMac } from './construct/jenkins/agent-mac';
import { UnityAccelerator } from './construct/unity-accelerator';
import { Size } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize } from 'aws-cdk-lib/aws-ec2';

interface AgentFleetConfiguration {
  type: 'LinuxFleet' | 'WindowsFleet';

  /**
   * A unique identifier for this agent
   */
  name: string;

  /**
   * Jenkins node label
   */
  label: string;

  /**
   * @default Size.gibibytes(30)
   */
  rootVolumeSize?: Size;

  /**
   * @default No data volume
   */
  dataVolumeSize?: Size;

  /**
   * @default [ec2.InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM)]
   */
  instanceTypes?: ec2.InstanceType[];

  /**
   * @default 1
   */
  fleetMinSize?: number;

  /**
   * @default 1
   */
  fleetMaxSize?: number;

  /**
   * Jenkins numExecutors for each node
   *
   * @default 1
   */
  numExecutors?: number;

  /**
   * @default vpc.privateSubnets
   */
  subnets?: (vpc: ec2.IVpc) => ec2.ISubnet[];
}

interface MacInstanceConfiguration {
  /**
   * Some AZs don't support Mac instances and you will see an error on CFn deployment.
   * In that case, please change the index of subnets (e.g. privateSubnets[0] or isolatedSubnets[1])
   * @default vpc.privateSubnet[0]
   */
  subnet?: (vpc: ec2.IVpc) => ec2.ISubnet;

  /**
   * @default Size.gigabytes(200)
   */
  storageSize?: Size;

  /**
   * @default InstanceType.of(InstanceClass.MAC2, InstanceSize.METAL)
   */
  instanceType?: ec2.InstanceType;

  /**
   * AMI ID to use for this mac instance.
   * Check https://console.aws.amazon.com/ec2/v2/home#AMICatalog:
   *
   * Please double check your region and CPU architecture matches your instance.
   */
  amiId: string;

  /**
   * A unique name for this Jenkins agent.
   */
  name: string;
}

interface UnityAcceleratorConfiguration {
  volumeSize: Size;

  /**
   * You can explicitly set a subnet that Unity accelerator is deployed at.
   * It can possibly improve the Accelerator performance to use the same Availability zone as the Jenkins agents.
   *
   * @default One of the vpc.privateSubnets
   */
  subnet?: (vpc: ec2.IVpc) => ec2.ISubnet;
}

interface JenkinsUnityBuildStackProps extends cdk.StackProps {
  /**
   * IP address ranges which you can access Jenkins Web UI from
   */
  readonly allowedCidrs: string[];

  /**
   * @default No EC2 fleet.
   */
  ec2FleetConfigurations?: AgentFleetConfiguration[];

  /**
   * @default No Mac instances.
   */
  macInstancesCOnfigurations?: MacInstanceConfiguration[];

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

  /**
   * The base URL for your Unity license server.
   * See this document for more details: https://docs.unity3d.com/licensing/manual/ClientConfig.html
   *
   * @default No license server (undefined)
   */
  readonly licenseServerBaseUrl?: string;

  /**
   * @default No Unity Accelerator.
   */
  readonly unityAccelerator?: UnityAcceleratorConfiguration;
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
      serverAccessLogsPrefix: 'artifactBucketAccessLogs/',
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    // If you want to use private container registry for Jenkins jobs, use this repository
    // By default it is not used at all.
    const containerRepository = new ecr.Repository(this, 'Repository', {
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // EC2 key pair that Jenkins controller uses to connect to Jenkins agents
    const keyPair = new ec2.KeyPair(this, 'KeyPair');

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      vpc,
      name: 'build',
    });

    let accelerator;
    if (props.unityAccelerator !== undefined) {
      const config = props.unityAccelerator;
      accelerator = new UnityAccelerator(this, 'UnityAccelerator', {
        vpc,
        namespace,
        storageSizeGb: config.volumeSize.toGibibytes(),
        // You can explicitly set a subnet that Unity accelerator is deployed at.
        // It can possibly improve the Accelerator performance to use the same Availability zone as the Jenkins agents.
        subnet: config.subnet ? config.subnet(vpc) : undefined,
      });
    }

    // const ec2FleetAgents = [];
    const ec2FleetAgents = (props.ec2FleetConfigurations ?? []).map((config) => {
      const ctor = config.type == 'WindowsFleet' ? AgentEC2Fleet.windowsFleet : AgentEC2Fleet.linuxFleet;
      return ctor(this, `${config.type}-${config.name}`, {
        vpc,
        sshKey: keyPair,
        artifactBucket,
        rootVolumeSize: config.rootVolumeSize ?? Size.gibibytes(30),
        dataVolumeSize: config.dataVolumeSize,
        instanceTypes: config.instanceTypes ?? [ec2.InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM)],
        name: config.name,
        label: config.label,
        fleetMinSize: config.fleetMinSize ?? 1,
        fleetMaxSize: config.fleetMaxSize ?? 1,
        numExecutors: config.numExecutors,
        subnets: config.subnets ? config.subnets(vpc) : undefined,
      });
    });

    const macAgents = (props.macInstancesCOnfigurations ?? []).map(
      (config) =>
        new AgentMac(this, `MacAgent-${config.name}`, {
          vpc,
          artifactBucket,
          subnet: config.subnet ? config.subnet(vpc) : vpc.privateSubnets[0],
          storageSize: config.storageSize ?? Size.gibibytes(200),
          instanceType: config.instanceType?.toString() ?? 'mac2.metal',
          sshKey: keyPair,
          amiId: config.amiId,
          name: config.name,
        }),
    );

    const controllerEcs = new Controller(this, 'JenkinsController', {
      vpc,
      allowedCidrs: props.allowedCidrs,
      logBucket,
      artifactBucket,
      certificateArn: props.certificateArn,
      environmentSecrets: { PRIVATE_KEY: Secret.fromSsmParameter(keyPair.privateKey) },
      environmentVariables: {
        ...(accelerator ? { UNITY_ACCELERATOR_URL: accelerator.endpoint } : {}),
        UNITY_BUILD_SERVER_URL: props.licenseServerBaseUrl ?? '',
      },
      containerRepository,
      macAgents: macAgents,
      ec2FleetAgents: ec2FleetAgents,
    });
    ec2FleetAgents.forEach((agent) => agent.allowSSHFrom(controllerEcs.service));
    macAgents.forEach((agent) => agent.allowSSHFrom(controllerEcs.service));
  }
}

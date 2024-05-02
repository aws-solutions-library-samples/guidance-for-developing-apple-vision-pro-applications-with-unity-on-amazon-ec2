import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface AgentEC2FleetPropsBase {
  readonly vpc: ec2.IVpc;
  readonly sshKey: ec2.IKeyPair;
  readonly instanceTypes: ec2.InstanceType[];

  /**
   * Name of the fleet. This must be a unique identifier across all the fleets.
   */
  readonly name: string;

  /**
   * Label string applied to the nodes in this fleet.
   * You can use space separated string to apply multiple labels. (e.g. `label1 label2`)
   */
  readonly label: string;

  readonly fleetMinSize: number;
  readonly fleetMaxSize: number;

  readonly rootVolumeSize: cdk.Size;

  /**
   * A S3 bucket this fleet has access (read/write) to.
   * @default No bucket.
   */
  readonly artifactBucket?: s3.IBucket;

  /**
   * The size of a data volume that is attached as a secondary volume to an instance.
   * A data volume will be not deleted when an instance is terminated and reattached by new instances.
   *
   * @default No data volume is created.
   */
  readonly dataVolumeSize?: cdk.Size;

  /**
   * @default deployed in vpc.privateSubnets
   */
  readonly subnets?: ec2.ISubnet[];

  /**
   * @default No additional policies added.
   */
  readonly policyStatements?: iam.PolicyStatement[];

  /**
   * Iops for gp3 volumes. Set integer from 3000 to 16000.
   * @default 3000
   */
  readonly volumeIops?: number;

  /**
   * Throughput for gp3 volumes. Set integer from 125 to 1000.
   * @default 125 MiB/s
   */
  readonly volumeThroughput?: number;

  /**
   * The number of executors in a single Jenkins agent node.
   * @default 1
   */
  readonly numExecutors?: number;
}

export interface AgentEC2FleetProps extends AgentEC2FleetPropsBase {
  readonly machineImage: ec2.IMachineImage;
  readonly userData: ec2.UserData;
  readonly rootVolumeDeviceName: string;
  readonly fsRoot: string;
  readonly sshCredentialsId: string;

  readonly sshConnectTimeoutSeconds: number;
  readonly sshConnectMaxNumRetries: number;
  readonly sshConnectRetryWaitTime: number;

  readonly jvmOptions: string;
  readonly prefixStartSlaveCmd: string;
  readonly suffixStartSlaveCmd: string;
}

export interface AgentEC2FleetPropsCommon extends AgentEC2FleetPropsBase {
  /**
   * @default the latest OS image.
   */
  readonly amiId?: string;
  readonly fsRoot?: string;

  readonly sshConnectTimeoutSeconds?: number;
  readonly sshConnectMaxNumRetries?: number;
  readonly sshConnectRetryWaitTime?: number;

  readonly jvmOptions?: string;
  readonly prefixStartSlaveCmd?: string;
  readonly suffixStartSlaveCmd?: string;
}

export interface AgentEC2FleetLinuxProps extends AgentEC2FleetPropsCommon {}

export interface AgentEC2FleetWindowsProps extends AgentEC2FleetPropsCommon {}

/**
 * Fleet of EC2 instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentEC2Fleet extends Construct {
  public readonly fleetAsgName: string;
  public readonly launchTemplate: ec2.LaunchTemplate;

  public readonly fleetMinSize: number;
  public readonly fleetMaxSize: number;
  public readonly numExecutors: number;

  public readonly name: string;
  public readonly label: string;
  public readonly sshCredentialsId: string;
  public readonly fsRoot: string;
  public readonly rootVolumeDeviceName: string;

  public readonly sshConnectTimeoutSeconds: number;
  public readonly sshConnectMaxNumRetries: number;
  public readonly sshConnectRetryWaitTime: number;

  public readonly jvmOptions: string;
  public readonly prefixStartSlaveCmd: string;
  public readonly suffixStartSlaveCmd: string;

  constructor(scope: Construct, id: string, props: AgentEC2FleetProps) {
    super(scope, id);

    this.fleetMinSize = props.fleetMinSize;
    this.fleetMaxSize = props.fleetMaxSize;
    this.numExecutors = props.numExecutors ?? 1;

    this.name = props.name;
    this.label = props.label;
    this.sshCredentialsId = props.sshCredentialsId;
    this.fsRoot = props.fsRoot;
    this.rootVolumeDeviceName = props.rootVolumeDeviceName;

    this.sshConnectTimeoutSeconds = props.sshConnectTimeoutSeconds;
    this.sshConnectMaxNumRetries = props.sshConnectMaxNumRetries;
    this.sshConnectRetryWaitTime = props.sshConnectRetryWaitTime;

    this.jvmOptions = props.jvmOptions;
    this.prefixStartSlaveCmd = props.prefixStartSlaveCmd;
    this.suffixStartSlaveCmd = props.suffixStartSlaveCmd;

    const { vpc, subnets = vpc.privateSubnets, instanceTypes, dataVolumeSize } = props;

    if (subnets.length == 0) {
      throw new Error('No subnet is available. Please specify one or more valid subnets to deploy the fleet.');
    }

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: props.machineImage,
      blockDevices: [
        {
          deviceName: props.rootVolumeDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeSize.toGibibytes(), {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            iops: props.volumeIops,
          }),
        },
      ],
      keyPair: props.sshKey,
      userData: props.userData,
      role: new iam.Role(this, 'Role', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      }),
      securityGroup: new ec2.SecurityGroup(this, 'SecurityGroup', {
        vpc,
      }),
    });

    // You can adjust throughput (MB/s) of the gp3 EBS volume, which is currently not exposed to the L2 construct.
    // https://github.com/aws/aws-cdk/issues/16213
    // https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/824
    (launchTemplate.node.defaultChild as cdk.CfnResource).addPropertyOverride(
      'LaunchTemplateData.BlockDeviceMappings.0.Ebs.Throughput',
      props.volumeThroughput,
    );

    props.artifactBucket?.grantReadWrite(launchTemplate);
    props.policyStatements?.forEach((policy) => launchTemplate.role!.addToPrincipalPolicy(policy));

    const fleet = new autoscaling.AutoScalingGroup(this, 'Fleet', {
      vpc,
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0,
          // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-fleet-allocation-strategy.html
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
        launchTemplate,
        launchTemplateOverrides: instanceTypes.map((type) => ({ instanceType: type })),
      },
      vpcSubnets: { subnets },
    });

    if (dataVolumeSize != null) {
      const kind = `${cdk.Stack.of(this).stackName}-${id}`;
      const volumesPerAz = Math.ceil(props.fleetMaxSize / subnets.length);

      // create a pool of EBS volumes
      subnets
        .flatMap((subnet, azIndex) =>
          Array.from({ length: volumesPerAz }, (_, volumeIndex) => ({
            az: subnet.availabilityZone,
            azIndex,
            volumeIndex,
          })),
        )
        .forEach((info) => {
          const volume = new ec2.Volume(this, `Volume-v1-${info.azIndex}-${info.volumeIndex}`, {
            availabilityZone: info.az,
            size: cdk.Size.gibibytes(dataVolumeSize.toGibibytes()),
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            throughput: props.volumeThroughput,
            iops: props.volumeIops,
            encrypted: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          });

          const tags = cdk.Tags.of(volume);
          tags.add('Name', `${kind}-${info.azIndex}-${info.volumeIndex}`);
          tags.add('Kind', kind);

          volume.grantAttachVolume(launchTemplate);
          volume.grantDetachVolume(launchTemplate);
        });
      launchTemplate.role!.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ec2:DescribeVolumes'],
          resources: ['*'],
        }),
      );
    }

    this.launchTemplate = launchTemplate;
    this.fleetAsgName = fleet.autoScalingGroupName;
  }

  public allowSSHFrom(other: ec2.IConnectable) {
    this.launchTemplate.connections.allowFrom(other, ec2.Port.tcp(22));
  }

  public static linuxFleet(scope: Construct, id: string, props: AgentEC2FleetLinuxProps) {
    const script = readFileSync(join(__dirname, 'resources', 'agent-userdata.sh'), 'utf8');

    const commands = script.replace('<KIND_TAG>', `${cdk.Stack.of(scope).stackName}-${id}`).split('\n');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(...commands);
    return new AgentEC2Fleet(scope, id, {
      machineImage: props.amiId
        ? ec2.MachineImage.genericLinux({ [cdk.Stack.of(scope).region]: props.amiId })
        : ec2.MachineImage.latestAmazonLinux2023(),
      userData: userData,
      rootVolumeDeviceName: '/dev/xvda',
      fsRoot: props.fsRoot ?? '/data/jenkins-agent',
      jvmOptions: props.jvmOptions ?? '',
      prefixStartSlaveCmd: props.prefixStartSlaveCmd ?? '',
      suffixStartSlaveCmd: props.suffixStartSlaveCmd ?? '',
      sshCredentialsId: 'instance-ssh-key-unix',
      sshConnectTimeoutSeconds: props.sshConnectTimeoutSeconds ?? 60,
      sshConnectMaxNumRetries: props.sshConnectMaxNumRetries ?? 10,
      sshConnectRetryWaitTime: props.sshConnectRetryWaitTime ?? 15,
      ...(props as AgentEC2FleetPropsBase),
    });
  }

  public static windowsFleet(scope: Construct, id: string, props: AgentEC2FleetWindowsProps) {
    const script = readFileSync(join(__dirname, 'resources', 'agent-userdata-windows.yml'), 'utf8');
    const userDataContent = script.replace('<KIND_TAG>', `${cdk.Stack.of(scope).stackName}-${id}`);
    const userData = ec2.UserData.custom(userDataContent);

    return new AgentEC2Fleet(scope, id, {
      machineImage: props.amiId
        ? ec2.MachineImage.genericWindows({ [cdk.Stack.of(scope).region]: props.amiId })
        : ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE),
      userData: userData,
      rootVolumeDeviceName: '/dev/sda1',

      jvmOptions: props.jvmOptions ?? '-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8',
      ...(props.dataVolumeSize != null
        ? {
            fsRoot: props.fsRoot ?? 'D:\\Jenkins',
            prefixStartSlaveCmd: props.prefixStartSlaveCmd ?? 'cd /d D:\\ && ',
            suffixStartSlaveCmd: props.suffixStartSlaveCmd ?? '',
          }
        : {
            fsRoot: props.fsRoot ?? 'C:\\Jenkins',
            prefixStartSlaveCmd: props.prefixStartSlaveCmd ?? '',
            suffixStartSlaveCmd: props.suffixStartSlaveCmd ?? '',
          }),

      sshCredentialsId: 'instance-ssh-key-windows',
      sshConnectTimeoutSeconds: props.sshConnectTimeoutSeconds ?? 60,
      sshConnectMaxNumRetries: props.sshConnectMaxNumRetries ?? 30,
      sshConnectRetryWaitTime: props.sshConnectRetryWaitTime ?? 15,
      ...(props as AgentEC2FleetPropsBase),
    });
  }
}

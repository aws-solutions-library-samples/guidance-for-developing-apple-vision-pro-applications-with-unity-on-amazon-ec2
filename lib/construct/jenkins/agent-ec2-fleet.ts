import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface AgentEC2FleetProps {
  readonly vpc: ec2.IVpc;
  readonly sshKeyName: string;
  readonly artifactBucket?: s3.IBucket;
  readonly instanceTypes: ec2.InstanceType[];

  readonly name: string;
  readonly label: string;
  readonly fleetMinSize: number;
  readonly fleetMaxSize: number;

  readonly rootVolumeSize: cdk.Size;

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
}

/**
 * Fleet of EC2 instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export abstract class AgentEC2Fleet extends Construct {
  public readonly fleetAsgName: string;
  public readonly launchTemplate: ec2.LaunchTemplate;

  public readonly name: string;
  public readonly label: string;
  public readonly fleetMinSize: number;
  public readonly fleetMaxSize: number;
  public readonly launchTemplateId?: string;

  protected abstract getMachineImage(): ec2.IMachineImage;
  protected abstract getRootVolumeDeviceName(): string;
  protected abstract getUserData(): ec2.UserData;

  constructor(scope: Construct, id: string, props: AgentEC2FleetProps) {
    super(scope, id);

    const { vpc, subnets = vpc.privateSubnets, instanceTypes, dataVolumeSize } = props;

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: this.getMachineImage(),
      blockDevices: [
        {
          deviceName: this.getRootVolumeDeviceName(),
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeSize.toGibibytes(), {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      keyName: props.sshKeyName,
      userData: this.getUserData(),
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
      150,
    );

    props.artifactBucket?.grantReadWrite(launchTemplate);
    props.policyStatements?.forEach(policy => launchTemplate.role!.addToPrincipalPolicy(policy));

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
        launchTemplateOverrides: instanceTypes.map(type => ({ instanceType: type })),
      },
      vpcSubnets: { subnets },
    });

    if (dataVolumeSize !== undefined) {
      // create a pool of EBS volumes
      const volumes = subnets
        .flatMap(subnet => subnet.availabilityZone)
        .flatMap((az, azIndex) => Array.from({
          length: Math.floor(props.fleetMaxSize / subnets.length)
        }, (_, i) => new ec2.Volume(this, `Volume-v1-${azIndex}-${i}`, {
          availabilityZone: az,
          size: cdk.Size.gibibytes(dataVolumeSize.toGibibytes()),
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          throughput: 200,
          iops: 3000,
          encrypted: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })));
      volumes.forEach((volume) => {
        cdk.Tags.of(volume).add('Kind', `${cdk.Stack.of(this).stackName}-${this.node.id}`);
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

    this.name = props.name;
    this.label = props.label;
    this.fleetMinSize = props.fleetMinSize;
    this.fleetMaxSize = props.fleetMaxSize;
    this.launchTemplateId = launchTemplate.launchTemplateId;
  }

  public allowSSHFrom(other: ec2.IConnectable) {
    this.launchTemplate.connections.allowFrom(other, ec2.Port.tcp(22));
  }
}

import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { AutoScalingGroup, SpotAllocationStrategy } from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnResource, RemovalPolicy, Size, Stack, Tags } from 'aws-cdk-lib';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { readFileSync } from 'fs';

export interface AgentLinuxProps {
  readonly vpc: IVpc;
  readonly sshKeyName: string;
  readonly artifactBucket?: IBucket;
  readonly instanceTypes: ec2.InstanceType[];
  readonly fleetMaxSize: number;
  readonly rootVolumeSize: Size;

  /**
   * The size of a data volume that is attached as a secondary volume to an instance.
   * A data volume will be not deleted when an instance is terminated and reattached by new instances.
   *
   * @default No data volume is created.
   */
  readonly dataVolumeSize?: Size;

  /**
   * @default deployed in vpc.privateSubnets
   */
  readonly subnets?: ec2.ISubnet[];

  /**
   * @default the latest Amazon Linux 2 image.
   */
  readonly amiId?: string;

  /**
   * @default No additional policies added.
   */
  readonly policyStatements?: PolicyStatement[];
}

/**
 * Fleet of Linux instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentLinux extends Construct {
  public readonly fleetName: string;
  public readonly launchTemplate: ec2.LaunchTemplate;
  public readonly fleetMaxSize: number;

  constructor(scope: Construct, id: string, props: AgentLinuxProps) {
    super(scope, id);

    const { vpc, subnets = vpc.privateSubnets, instanceTypes, dataVolumeSize } = props;

    const userData = ec2.UserData.forLinux();

    let script = readFileSync('./lib/construct/jenkins/resources/agent-userdata.sh', 'utf8');
    script = script.replace('<KIND_TAG>', `${Stack.of(this).stackName}-${this.node.id}`);
    userData.addCommands(...script.split('\n'));

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: props.amiId
        ? ec2.MachineImage.genericLinux({ [Stack.of(this).region]: props.amiId })
        : ec2.MachineImage.latestAmazonLinux2023(),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeSize.toGibibytes(), {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      keyName: props.sshKeyName,
      userData,
      role: new iam.Role(this, 'Role', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      }),
      securityGroup: new ec2.SecurityGroup(this, 'SecurityGroup', {
        vpc,
      }),
    });

    // You can adjust throughput (MB/s) of the gp3 EBS volume
    (launchTemplate.node.defaultChild as CfnResource).addPropertyOverride(
      'LaunchTemplateData.BlockDeviceMappings.0.Ebs.Throughput',
      150,
    );

    props.artifactBucket?.grantReadWrite(launchTemplate);
    (props.policyStatements ?? []).forEach((policy) => launchTemplate.role!.addToPrincipalPolicy(policy));

    const fleet = new AutoScalingGroup(this, 'Fleet', {
      vpc,
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0,
          // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-fleet-allocation-strategy.html
          spotAllocationStrategy: SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
        launchTemplate,
        launchTemplateOverrides: instanceTypes.map((type) => ({
          instanceType: type,
        })),
      },
      vpcSubnets: { subnets },
    });

    if (dataVolumeSize !== undefined) {
      // create a pool of EBS volumes
      const volumes = subnets
        .flatMap((subnet) => subnet.availabilityZone)
        .flatMap((az, azi) =>
          new Array(Math.floor(props.fleetMaxSize / subnets.length)).fill(0).map(
            (_, i) =>
              new ec2.Volume(this, `Volume-v1-${azi}-${i}`, {
                availabilityZone: az,
                size: Size.gibibytes(dataVolumeSize.toGibibytes()),
                volumeType: ec2.EbsDeviceVolumeType.GP3,
                throughput: 200,
                iops: 3000,
                encrypted: true,
                removalPolicy: RemovalPolicy.DESTROY,
              }),
          ),
        );
      volumes.forEach((volume) => {
        Tags.of(volume).add('Kind', `${Stack.of(this).stackName}-${this.node.id}`);
        volume.grantAttachVolume(launchTemplate);
        volume.grantDetachVolume(launchTemplate);
      });
      launchTemplate.role?.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ec2:DescribeVolumes'],
          resources: ['*'],
        }),
      );
    }

    this.launchTemplate = launchTemplate;
    this.fleetName = fleet.autoScalingGroupName;
    this.fleetMaxSize = props.fleetMaxSize;
  }

  public allowSSHFrom(other: ec2.IConnectable) {
    this.launchTemplate.connections.allowFrom(other, ec2.Port.tcp(22));
  }
}

import { AmazonLinuxGeneration, InstanceClass, InstanceSize, IVpc, LaunchTemplate, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { AutoScalingGroup, SpotAllocationStrategy } from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnResource, Stack } from 'aws-cdk-lib';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

export interface AgentProps {
  readonly vpc: IVpc;
  readonly sshKeyName: string;
  readonly storageSizeGb: number;
  readonly artifactBucket?: IBucket;
  readonly subnets?: ec2.ISubnet[];
  readonly amiId?: string;
  readonly instanceTypes: ec2.InstanceType[];
  readonly policyStatements?: PolicyStatement[];
}

/**
 * Fleet of Linux instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentEC2 extends Construct {
  public fleetName: string;
  public launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: AgentProps) {
    super(scope, id);

    const { vpc, subnets = vpc.privateSubnets, instanceTypes } = props;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Update AWS CLI to v2
      'rm -rf /usr/local/aws',
      'rm /usr/local/bin/aws',
      'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"',
      'unzip awscliv2.zip',
      './aws/install',
      'yum update -y',
      'yum install -y java-17-amazon-corretto-headless git docker jq',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ec2-user',
      'chmod 777 /var/run/docker.sock',
      'curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | bash',
      'yum install -y git-lfs',
      'docker pull unityci/editor:2021.3.14f1-ios-1.0', // prefetch
      'yum install -y tmux htop' // not necessary but useful for debugging
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: props.amiId
        ? ec2.MachineImage.genericLinux({ [Stack.of(this).region]: props.amiId })
        : ec2.MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          }),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(props.storageSizeGb, {
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
    (launchTemplate.node.defaultChild as CfnResource).addPropertyOverride('LaunchTemplateData.BlockDeviceMappings.0.Ebs.Throughput', 200);

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

    this.launchTemplate = launchTemplate;
    this.fleetName = fleet.autoScalingGroupName;
  }

  public allowSSHFrom(other: ec2.IConnectable) {
    this.launchTemplate.connections.allowFrom(other, ec2.Port.tcp(22));
  }
}

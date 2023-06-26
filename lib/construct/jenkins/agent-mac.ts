import { CfnHost, EbsDeviceVolumeType, Instance, InstanceType, IVpc, OperatingSystemType } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnOutput, RemovalPolicy, Size } from 'aws-cdk-lib';

export interface AgentMacProps {
  readonly vpc: IVpc;
  readonly sshKeyName: string;
  readonly amiId: string;
  readonly storageSize: Size;
  readonly instanceType: 'mac1.metal' | 'mac2.metal';
  readonly name: string;
  readonly artifactBucket?: IBucket;
  readonly subnet: ec2.ISubnet;
}

/**
 * A mac instance with a dedicated host.
 */
export class AgentMac extends Construct {
  public readonly ipAddress: string;
  public readonly name: string;
  public readonly sshCredentialsId: string;

  private readonly instance: Instance;

  constructor(scope: Construct, id: string, props: AgentMacProps) {
    super(scope, id);

    this.name = props.name;
    this.sshCredentialsId = 'instance-ssh-key-unix';

    const { vpc, instanceType, subnet } = props;

    if (subnet == null) {
      throw new Error(
        'Invalid subnet. Please try different subnet type (privateSubnets, isolatedSubnets, or publicSubnets) or index.',
      );
    }

    const host = new CfnHost(this, 'DedicatedHost', {
      availabilityZone: subnet.availabilityZone,
      instanceType,
    });
    // In some cases, we cannot delete a dedicated host immediately (e.g. 24 hours before its creation).
    // That's why we set RemovalPolicy = RETAIN here to avoid CFn errors.
    host.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // Brew installation path differs with mac1 (Intel) and mac2 (M1)
    const brewPath = instanceType == 'mac2.metal' ? '/opt/homebrew' : '/usr/local';
    const userData = ec2.UserData.custom(`#!/bin/zsh
#install openjdk@17
su ec2-user -c '${brewPath}/bin/brew install openjdk@17 jq'
ln -sfn ${brewPath}/opt/openjdk@17/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-17.jdk
java -version

# resize disk to match the ebs volume
# https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html#mac-instance-increase-volume
PDISK=$(diskutil list physical external | head -n1 | cut -d" " -f1)
APFSCONT=$(diskutil list physical external | grep "Apple_APFS" | tr -s " " | cut -d" " -f8)
yes | diskutil repairDisk $PDISK
diskutil apfs resizeContainer $APFSCONT 0

# Start the ARD Agent
# https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html#connect-to-mac-instance
/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -activate -configure -access -on -restart -agent -privs -all
    `);

    const instance = new Instance(this, 'Instance', {
      vpc,
      instanceType: new InstanceType(instanceType),
      machineImage: {
        getImage: (_scope) => ({
          imageId: props.amiId,
          osType: OperatingSystemType.UNKNOWN,
          userData: userData,
        }),
      },
      vpcSubnets: { subnets: [subnet] },
      keyName: props.sshKeyName,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(props.storageSize.toGibibytes(), {
            encrypted: true,
            volumeType: EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      ssmSessionPermissions: true,
    });
    // You can enable termination protection by uncommenting this line.
    // (instance.node.defaultChild as ec2.CfnInstance).disableApiTermination = true;

    instance.instance.tenancy = 'host';
    instance.instance.hostId = host.attrHostId;
    props.artifactBucket?.grantReadWrite(instance);

    this.instance = instance;
    this.ipAddress = instance.instancePrivateIp;

    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
  }

  public allowSSHFrom(other: ec2.IConnectable) {
    this.instance.connections.allowFrom(other, ec2.Port.tcp(22));
  }
}

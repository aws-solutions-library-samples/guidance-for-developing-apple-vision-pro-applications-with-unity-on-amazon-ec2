import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { CfnOutput } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface UnityAcceleratorProps {
  readonly vpc: ec2.IVpc;
  readonly namespace: servicediscovery.PrivateDnsNamespace;
  readonly storageSizeGb: number;
  readonly instanceType?: ec2.InstanceType;
  readonly subnet?: ec2.ISubnet;
}

export class UnityAccelerator extends Construct {
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, props: UnityAcceleratorProps) {
    super(scope, id);

    const {
      vpc,
      namespace,
      subnet,
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
    } = props;
    // The port Accelerator uses: https://docs.unity3d.com/Manual/UnityAccelerator.html#docker
    const servicePort = 10080;

    // Allow access via a domain name instead of an IP address. accelerator.build
    const service = namespace.createService('Service', {
      name: 'accelerator',
    });

    let script = readFileSync(join(__dirname, 'resources', 'unity-accelerator-init-config.yaml'), 'utf8');
    // Remove all the comments (begins with a # ) since CFn does not support letters other than ASCII.
    script = script
      .split('\n')
      .map((line) => line.replace(/#\s.*/g, ''))
      .join('\n');
    const userData = ec2.UserData.custom(script);

    const instance = new ec2.Instance(this, 'Default', {
      vpc,
      instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        userData,
        // Uncomment this line to avoid from accidental replacement of the instance.
        // You need to set account and region of the stack explicitly for this to work.
        // cachedInContext: true,
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
      vpcSubnets: subnet == null ? undefined : { subnets: [subnet] },
    });
    // You can enable termination protection by uncommenting this line.
    // (instance.node.defaultChild as ec2.CfnInstance).disableApiTermination = true;

    instance.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    instance.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(servicePort));

    service.registerIpInstance('Instance', {
      ipv4: instance.instancePrivateIp,
    });

    this.endpoint = `${service.serviceName}.${namespace.namespaceName}:${servicePort}`;

    new CfnOutput(this, 'Endpoint', { value: this.endpoint });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
  }
}

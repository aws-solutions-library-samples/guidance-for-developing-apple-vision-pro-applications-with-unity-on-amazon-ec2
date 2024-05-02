import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { JenkinsUnityBuildStack } from '../lib/jenkins-unity-build-stack';
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { Size } from 'aws-cdk-lib';
import { InstanceType, InstanceClass, InstanceSize } from 'aws-cdk-lib/aws-ec2';

test('Snapshot test', () => {
  // remove all the intermediate files that are created before the test
  const jenkinsResourceDir = join(__dirname, '..', 'lib', 'construct', 'jenkins', 'resources', 'config');
  readdirSync(jenkinsResourceDir)
    .filter((path) => path.match(/^jenkins.+yaml$/) != null)
    .forEach((path) => rmSync(join(jenkinsResourceDir, path)));

  const app = new cdk.App();
  const stack = new JenkinsUnityBuildStack(app, 'TestStack', {
    env: {
      region: 'us-east-2',
    },
    allowedCidrs: ['127.0.0.1/32'],
    licenseServerBaseUrl: 'http://10.0.0.100:8080',
    ec2FleetConfigurations: [
      {
        type: 'LinuxFleet',
        rootVolumeSize: Size.gibibytes(30),
        dataVolumeSize: Size.gibibytes(100),
        instanceTypes: [
          InstanceType.of(InstanceClass.C5, InstanceSize.XLARGE),
          InstanceType.of(InstanceClass.C5A, InstanceSize.XLARGE),
          InstanceType.of(InstanceClass.C5N, InstanceSize.XLARGE),
          InstanceType.of(InstanceClass.C4, InstanceSize.XLARGE),
        ],
        name: 'linux-fleet',
        label: 'linux',
        fleetMinSize: 1,
        fleetMaxSize: 4,
      },
      {
        type: 'LinuxFleet',
        name: 'linux-fleet-small',
        label: 'small',
        fleetMinSize: 1,
        fleetMaxSize: 2,
        numExecutors: 5,
        instanceTypes: [InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM)],
      },
      {
        type: 'WindowsFleet',
        rootVolumeSize: Size.gibibytes(50),
        dataVolumeSize: Size.gibibytes(100),
        // You may want to add several instance types to avoid from insufficient Spot capacity.
        instanceTypes: [
          InstanceType.of(InstanceClass.M6A, InstanceSize.XLARGE),
          InstanceType.of(InstanceClass.M5A, InstanceSize.XLARGE),
          InstanceType.of(InstanceClass.M5N, InstanceSize.XLARGE),
          InstanceType.of(InstanceClass.M5, InstanceSize.XLARGE),
        ],
        name: 'windows-fleet',
        label: 'windows',
        fleetMinSize: 1,
        fleetMaxSize: 4,
      },
    ],
    macInstancesCOnfigurations: [
      {
        storageSize: Size.gibibytes(200),
        instanceType: InstanceType.of(InstanceClass.MAC1, InstanceSize.METAL),
        amiId: 'ami-013846afc111c94b0',
        name: 'mac0',
      },
    ],
    unityAccelerator: {
      volumeSize: Size.gibibytes(300),
      subnet: (vpc) => vpc.privateSubnets[1],
    },
  });
  const template = Template.fromStack(stack);
  expect(template).toMatchSnapshot();
});

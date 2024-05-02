#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { JenkinsUnityBuildStack } from '../lib/jenkins-unity-build-stack';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { Size } from 'aws-cdk-lib';

const app = new cdk.App();
new JenkinsUnityBuildStack(app, 'JenkinsUnityBuildStack', {
  env: {
    // AWS region to deploy this stack to. (Required for defining ALB access logging)
    region: 'us-east-2',
    // Aws Account ID to deploy this stack to. (Also required if you specify certificateArn or vpcId below.)
    // account: '123456789012',
  },
  allowedCidrs: ['127.0.0.1/32'],

  // Amazon Certificate Manager certificate ARN for Jenkins Web UI ALB.
  // ALB can be accessed with HTTP if you don't specify this property.
  // certificateArn: "",

  // You can use an existing VPC by specifying vpcId.
  // vpcId: 'vpc-xxxxxxx',

  ec2FleetConfigurations: [
    {
      type: 'LinuxFleet',
      name: 'linux-small',
      label: 'small',
      numExecutors: 5,
    },
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
    // You can add Windows fleet as well.
    // {
    //   type: 'WindowsFleet',
    //   rootVolumeSize: Size.gibibytes(50),
    //   dataVolumeSize: Size.gibibytes(100),
    //   instanceTypes: [
    //     InstanceType.of(InstanceClass.M6A, InstanceSize.XLARGE),
    //     InstanceType.of(InstanceClass.M5A, InstanceSize.XLARGE),
    //     InstanceType.of(InstanceClass.M5N, InstanceSize.XLARGE),
    //     InstanceType.of(InstanceClass.M5, InstanceSize.XLARGE),
    //   ],
    //   name: 'windows-fleet',
    //   label: 'windows',
    //   fleetMinSize: 1,
    //   fleetMaxSize: 4,
    // },
  ],

  // You can add any number of Mac agents.
  // macInstancesCOnfigurations: [
  //   {
  //     storageSize: cdk.Size.gibibytes(200),
  //     instanceType: InstanceType.of(InstanceClass.MAC2, InstanceSize.METAL),
  //     amiId: 'ami-038e1d574f3140013',
  //     name: 'mac0',
  //     subnet: (vpc) => vpc.privateSubnets[1],
  //   },
  // ],

  // You can deploy Unity Accelerator.
  // unityAccelerator: {
  //   volumeSize: Size.gibibytes(100),
  // }

  // base url for your Unity license sever.
  // You can setup one using this project: https://github.com/aws-samples/unity-build-server-with-aws-cdk
  // licenseServerBaseUrl: 'http://10.0.0.100:8080',
});

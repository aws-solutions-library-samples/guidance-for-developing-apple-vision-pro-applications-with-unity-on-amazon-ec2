#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { JenkinsUnityBuildStack } from '../lib/jenkins-unity-build-stack';

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

  // Get the AMI ID for Mac instances from this page. Please make sure the region is correct.
  // https://console.aws.amazon.com/ec2/v2/home#AMICatalog:
  // macAmiId: 'ami-0665a0b2ea8636d1d', // Monterey Intel mac @us-east-2
  // macAmiId: 'ami-013846afc111c94b0', // Monterey M1 mac @us-east-2

  // You can use an existing VPC by specifying vpcId.
  // vpcId: 'vpc-xxxxxxx',

  // base url for your Unity license sever.
  // You can setup one using this project: https://github.com/aws-samples/unity-build-server-with-aws-cdk
  // licenseServerBaseUrl: 'http://10.0.0.100:8080',
});

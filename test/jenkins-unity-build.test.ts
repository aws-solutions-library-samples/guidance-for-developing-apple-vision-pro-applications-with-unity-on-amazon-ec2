import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { JenkinsUnityBuildStack } from '../lib/jenkins-unity-build-stack';

test('Snapshot test', () => {
  const app = new cdk.App();
  const stack = new JenkinsUnityBuildStack(app, 'TestStack', {
    env: {
      region: 'us-east-2',
    },
    allowedCidrs: ['127.0.0.1/32'],
    macAmiId: 'ami-013846afc111c94b0',
  });
  const template = Template.fromStack(stack);
  expect(template).toMatchSnapshot();
});

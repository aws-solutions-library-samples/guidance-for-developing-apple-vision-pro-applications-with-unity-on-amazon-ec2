import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { JenkinsUnityBuildStack } from '../lib/jenkins-unity-build-stack';
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';

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
    macAmiId: 'ami-013846afc111c94b0',
    licenseServerBaseUrl: 'http://10.0.0.100:8080',
    useWindows: true,
  });
  const template = Template.fromStack(stack);
  expect(template).toMatchSnapshot();
});

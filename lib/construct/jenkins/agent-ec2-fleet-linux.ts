import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { readFileSync } from 'fs';
import { AgentEC2Fleet, AgentEC2FleetProps } from './agent-ec2-fleet';

export interface AgentEC2FleetLinuxProps extends AgentEC2FleetProps {
}

/**
 * Fleet of Linux instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentEC2FleetLinux extends AgentEC2Fleet {
  constructor(scope: Construct, id: string, props: AgentEC2FleetLinuxProps) {
    super(scope, id, {
      defaultMachineImage: ec2.MachineImage.latestAmazonLinux2023(),
      machineImageFrom: (amiMap) => ec2.MachineImage.genericLinux(amiMap),

      get userData() {
        const script = readFileSync('./lib/construct/jenkins/resources/agent-userdata.sh', 'utf8');
        const commands = script.replace('<KIND_TAG>', `${cdk.Stack.of(scope).stackName}-${id}`).split('\n');

        const userData = ec2.UserData.forLinux();
        userData.addCommands(...commands);
        return userData;
      },

      rootVolumeDeviceName: '/dev/xvda',
      fsRoot: '/data/jenkins-agent',
    }, props);
  }
}

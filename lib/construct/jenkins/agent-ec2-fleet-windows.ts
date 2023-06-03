import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { readFileSync } from 'fs';
import { AgentEC2Fleet, AgentEC2FleetProps } from './agent-ec2-fleet';

export interface AgentEC2FleetWindowsProps extends AgentEC2FleetProps {
}

/**
 * Fleet of Windows instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentEC2FleetWindows extends AgentEC2Fleet {
  constructor(scope: Construct, id: string, props: AgentEC2FleetWindowsProps) {
    super(scope, id, {
      defaultMachineImage: ec2.MachineImage.fromSsmParameter('/aws/service/ami-windows-latest/EC2LaunchV2-Windows_Server-2019-English-Full-ContainersLatest', {
        os: ec2.OperatingSystemType.WINDOWS,
      }),
      machineImageFrom: (amiMap) => ec2.MachineImage.genericWindows(amiMap),

      get userData() {
        const script = readFileSync('./lib/construct/jenkins/resources/agent-userdata-windows.yml', 'utf8');
        const userDataContent = script.replace('<KIND_TAG>', `${cdk.Stack.of(scope).stackName}-${id}`);
        return ec2.UserData.custom(userDataContent);
      },

      rootVolumeDeviceName: '/dev/sda1',
      fsRoot: 'C:\\Jenkins',
    }, props);
  }
}

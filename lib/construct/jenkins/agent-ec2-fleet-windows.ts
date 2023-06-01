import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { readFileSync } from 'fs';
import { AgentEC2Fleet, AgentEC2FleetProps } from './agent-ec2-fleet';

export interface AgentEC2FleetWindowsProps extends AgentEC2FleetProps {
  /**
   * @default the latest Amazon Linux 2 image.
   */
  readonly amiId?: string;
}

/**
 * Fleet of Windows instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentEC2FleetWindows extends AgentEC2Fleet {
  public readonly amiId?: string;
  public readonly credentialsId: string;
  public readonly fsRoot: string;
  public readonly javaPath?: string;

  protected getMachineImage() {
    return ec2.MachineImage.genericWindows({
      [cdk.Stack.of(this).region]: this.amiId ?? 'ami-0a249b7e15c3c080e', // EC2LaunchV2-Windows_Server-2019-English-Full-ContainersLatest-2023.04.12
    });
  }

  protected getRootVolumeDeviceName() {
    return '/dev/sda1';
  }

  protected getUserData() {
    const script = readFileSync('./lib/construct/jenkins/resources/agent-userdata-windows.yml', 'utf8');
    const userDataContent = script.replace('<KIND_TAG>', `${cdk.Stack.of(this).stackName}-${this.node.id}`);
    return ec2.UserData.custom(userDataContent);
  }

  constructor(scope: Construct, id: string, props: AgentEC2FleetWindowsProps) {
    super(scope, id, props);

    this.amiId = props.amiId;
    this.credentialsId = 'instance-ssh-key-administrator';
    this.fsRoot = 'C:\\Jenkins';
    this.javaPath = 'C:\\Java\\jdk17.0.7_7\\bin\\java.exe';
  }
}

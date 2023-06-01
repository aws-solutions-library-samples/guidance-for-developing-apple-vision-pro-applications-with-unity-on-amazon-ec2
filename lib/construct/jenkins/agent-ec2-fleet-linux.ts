import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { readFileSync } from 'fs';
import { AgentEC2Fleet, AgentEC2FleetProps } from './agent-ec2-fleet';

export interface AgentEC2FleetLinuxProps extends AgentEC2FleetProps {
  /**
   * @default the latest Amazon Linux 2 image.
   */
  readonly amiId?: string;
}

/**
 * Fleet of Linux instances for Jenkins agents.
 * The number of instances is supposed to be controlled by Jenkins EC2 Fleet plugin.
 */
export class AgentEC2FleetLinux extends AgentEC2Fleet {
  public readonly amiId?: string;
  public readonly credentialsId: string;
  public readonly fsRoot: string;
  public readonly javaPath?: string;

  protected getMachineImage(): ec2.IMachineImage {
    return this.amiId
    ? ec2.MachineImage.genericLinux({ [cdk.Stack.of(this).region]: this.amiId })
    : ec2.MachineImage.latestAmazonLinux2023();
  }

  protected getRootVolumeDeviceName() {
    return '/dev/xvda';
  }

  protected getUserData() {
    const script = readFileSync('./lib/construct/jenkins/resources/agent-userdata.sh', 'utf8');
    const commands = script.replace('<KIND_TAG>', `${cdk.Stack.of(this).stackName}-${this.node.id}`).split('\n');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(...commands);
    return userData;
  }

  constructor(scope: Construct, id: string, props: AgentEC2FleetLinuxProps) {
    super(scope, id, props);

    this.amiId = props.amiId;
    this.credentialsId = 'instance-ssh-key-ec2-user';
    this.fsRoot = '/data/jenkins-agent';
  }
}

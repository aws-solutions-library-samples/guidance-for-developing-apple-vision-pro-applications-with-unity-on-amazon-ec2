import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface AgentKeyPairProps {
  readonly keyPairName: string;
}

export class AgentKeyPair extends Construct {
  readonly keyPairName: string;
  readonly privateKey: ssm.IStringParameter;
  constructor(scope: Construct, id: string, props: AgentKeyPairProps) {
    super(scope, id);

    const keyPair = new ec2.CfnKeyPair(this, 'KeyPair', {
      keyName: props.keyPairName,
    });
    // CfnKeyPair automatically creates a ssm parameter (secure string) for the private key.
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-keypair.html
    this.privateKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'KeyParam', {
      parameterName: `/ec2/keypair/${keyPair.attrKeyPairId}`,
      simpleName: false,
    });

    this.keyPairName = props.keyPairName;
  }
}

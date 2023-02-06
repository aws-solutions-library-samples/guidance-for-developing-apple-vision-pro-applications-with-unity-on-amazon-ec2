import { Construct } from 'constructs';
import { KeyPair } from 'cdk-ec2-key-pair';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';

export interface AgentKeyPairProps {
  readonly keyPairName: string;
}

export class AgentKeyPair extends Construct {
  readonly keyPairName: string;
  readonly privateKey: ISecret;
  constructor(scope: Construct, id: string, props: AgentKeyPairProps) {
    super(scope, id);

    // To workaround this issue: https://github.com/aws/aws-cdk/issues/17094, 
    // we are using cdk-ec2-key-pair instead of CfnKeyPair.
    const key = new KeyPair(this, 'KeyPair', {
      name: props.keyPairName,
      storePublicKey: true,
    });

    const param = Secret.fromSecretNameV2(this, 'KeyParam', `ec2-ssh-key/${props.keyPairName}/private`);
    param.node.addDependency(key);

    this.privateKey = param;
    this.keyPairName = key.keyPairName;

    // const keyPair = new ec2.CfnKeyPair(this, 'KeyPair', {
    //   keyName: props.uniqueKeyName,
    // });
    // // This code throws an error: https://github.com/aws/aws-cdk/issues/17094
    // const param = ssm.StringParameter.fromStringParameterAttributes(
    //   this,
    //   'KeyParam2',
    //   {
    //     parameterName: `/ec2/keypair/${keyPair.attrKeyPairId}`,
    //     simpleName: false,
    //   }
    // );
  }
}

# デプロイ手順書

本サンプルをデプロイする手順を記載します。

## 前提条件

はじめに、AWS CDK を実行できる環境を用意してください。これは、以下の条件を満たしている必要があります。

* 必要なソフトウェアがインストールされていること
    * [Node.js](https://nodejs.org/en/download/)
        * v16 以上を推奨
        * `node -v` コマンドで確認できます
    * [AWS CLI](https://docs.aws.amazon.com/ja_jp/cli/latest/userguide/getting-started-install.html)
        * v2 を推奨
        * `aws --version` コマンドで確認できます
    * Docker
        * `docker --version` コマンドで確認できます
* AWS CLI に適切な AWS IAM 権限 (Administrator相当が必要) が設定されていること
    * IAM ロールの設定をするか、 `aws configure` コマンドで IAM ユーザーの情報を入力してください
* インターネットに接続され、AWS API と疎通できること
    * 閉域環境などでは、正常に実行できない可能性があります

上記を満たす環境であれば、ローカル端末や AWS Cloud9、EC2 インスタンス等で利用可能です。上記の条件が確認できたら、次の手順に進んでください。

## CDK の利用準備

本プロトタイプのルートディレクトリ (`README.md` のあるディレクトリです) に移動し、以下のコマンドを実行してください。
なお、以降の `cdk` コマンドは全てこのルートディレクトリで実行することを想定しています。

```sh
# Node の依存パッケージをインストールします
npm ci
# ご利用の AWS 環境で CDK を利用できるように初期化を実行します
npx cdk bootstrap
```

`npm ci` は、Node の依存関係をインストールします。初回のみ必要です。

`cdk bootstrap` は、ご利用の環境で CDK を利用できるように初期設定をおこないます。
こちらはある AWS アカウント･あるリージョンで初めて CDK を利用する場合に必要です。2 回目以降は必要ありません。

✅ `Environment aws://xxxx/ap-northeast-1 bootstrapped` という旨が表示されていれば成功です。次の手順に進んでください。

## サンプルのデプロイ

CDK でスタックをデプロイします。

1. Jenkins ビルド環境のデプロイ
    * Jenkins 設定ファイル (`lib/construct/jenkins/resources/config/jenkins.yaml.ejs`) の内容を確認してください
        * パスワード (`password`) を十分強力なものに変更してください
        * 管理者メールアドレス (`adminAddress`) を管理者が利用可能なものに変更してください
    * Jenkins の管理画面にアクセスするグローバル IP アドレス (社内 VPN 等) を CIDR 形式で `bin/jenkins-unity-build.ts` の `allowedCidrs` に記入してください
        * 記入例: `const allowedCidrs = ['127.0.0.1/32', '100.200.0.0/16'];`
     * `bin/jenkins-unity-build.ts` を設定することで、既存のVPC上にシステムをデプロイすることも可能です
    * 以下のコマンドを実行し、Jenkins ビルド環境をデプロイします
        * `npx cdk deploy JenkinsUnityBuildStack`
    * デプロイ後、ターミナルに Outputs: 以下に表示される Jenkins Controller の URL を控えてください
    * Outputs 出力例:

    ```sh
    ✅  JenkinsUnityBuildStack

    ✨  Deployment time: 116.96s

    Outputs:
    JenkinsUnityBuildStack.JenkinsControllerLoadBalancerDomainName543C3FE0 = http://Unity-Jenki-xxxxxxxx.us-east-2.elb.amazonaws.com
    JenkinsUnityBuildStack.UnityAcceleratorUrl594D8007 = http://accelerator.build:10080
    Stack ARN:
    arn:aws:cloudformation:us-east-2:012345678901:stack/JenkinsUnityBuildStack/85318840-7f3a-11ed-8c6d-0ac490c584c0

    ✨  Total time: 129.94s
    ```
2. Macインスタンスのデプロイ
    * Macインスタンスはデプロイに失敗した場合の処理がやや大変なので、分けてデプロイしています
        * このデプロイでDedicated hostの確保もあわせて行います。必ず[Quota](https://ap-northeast-1.console.aws.amazon.com/servicequotas/home/services/ec2/quotas)を事前に確認し、Dedicated hostを追加で確保可能なことを確かめてください。
    * `bin/jenkins-unity-build.ts` の `macAmiId` をアンコメントし、適切なAMI ID (リージョンごとに異なります) を記入してください
    * その後、再度次のコマンドを実行してください: `npx cdk deploy JenkinsUnityBuildStack`
    * 数分程度でデプロイが完了し、Macインスタンスが起動します

    ```ts
    macAmiId: 'ami-0c24e9b8b57e79e8e', // Monterey Intel Mac @ap-northeast-1
    ```
3. Mac インスタンスの初期設定
    * [setup-mac-instance.md](./setup-mac-instance.md) を参考に、Mac インスタンスの初期設定を実行してください
4. Jenkins 管理画面の確認
    * 1 で表示された Jenkins Controller の　URL から Jenkins 管理画面にアクセスし、正常に表示されていることを確認してください
    * URL はマネジメントコンソールの [CloudFormation](https://ap-northeast-1.console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks) → [JenkinsUnityBuildStack] → [出力] からも参照することができます

以上で Unity ライセンスサーバーおよび Jenkins Controller, Agent のデプロイ作業は完了です。

## リソースの削除

リソースを削除する際は、以下の手順に沿ってください。

初めに、Jenkins の EC2 Fleet の インスタンス数を 0 にします。このためには、Jenkins のクラウド管理のページ (Dashboard -> Manage Jenkins -> Nodes -> Configure Clouds) から、EC2 Fleet の `Minimum Cluster Size` を0に設定してください。

すべての Linux/Windows Agent が削除されたことを Jenkins の GUI から確認したら、以下の CDK コマンドを実行してください:

```sh
npx cdk destroy --all
```

また、いくつかのリソースを自動で削除しないようにしています。以下の手順に沿って、手動で削除してください。

* EC2 Mac Dedicated host: Dedicated host を作成した直後24時間、また Mac インスタンスを終了した後 1-3 時間 (Pending 状態) は、Dedicated host を開放することができなくなります ([参照](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html#mac-instance-stop))。十分時間が経過した後にお試しください。開放するには、[こちらのページ](https://us-east-2.console.aws.amazon.com/ec2/home?region=us-east-2#Hosts:)で当該のホストを選択し、Actions → Release host をクリックします。

# Setup EC2 Mac instance
This sample already automates most of the initial setup process using AWS CDK.
As for macOS, however, some tasks must be done manually, such as installing Xcode.
This document describes what you need to do after the CDK deployment for EC2 Mac instances.

## Steps
Please run these steps after you confirmed your Mac instance is in `Running` state on the [EC2 management console](https://console.aws.amazon.com/ec2/home). You can find the instance by the Name tag as `JenkinsUnityBuildStack/JenkinsMacAgent*/Instance`.

### 1. Connect to the instance via Sessions Manager
You can connect your instance (like SSH) via the session manager of AWS Systems manager. Please follow the document for the detail: [Starting a session (Amazon EC2 console)](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#start-ec2-console). 

### 2. Set password for ec2-user
You need GUI access such as Apple Remote Desktop (ARD) in the following steps. To use ARD, you have to set password for the user you use in ARD session.

You can set password by [the below command](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html#connect-to-mac-instance) (execute it on the previous SSH session):

```sh
sudo passwd ec2-user
```

### 3. Forward ARD port to your local machine
Since ARD is already enabled in userData, you can now connect to the instance via ARD.

Run the following command in your local machine:

```sh
# You can get target instance ID in the EC2 management console
aws ssm start-session \
    --target i-xxxxxxxxxxxxxx \
    --document-name AWS-StartPortForwardingSession \
    --parameters '{"portNumber":["5900"], "localPortNumber":["5900"]}'
```

Note that you need to install AWS CLI Session Manager plugin to run the command: [Install the Session Manager plugin for the AWS CLI](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).

You should see a message like `Port 5900 opened for sessionId ...` if successful.
Note that you have to keep the session open while you are accessing the instance in the next step.

### 4. Connect to the instance via ARD
Now you can connect to `localhost:5900` by any VNC client you like. If you are using macOS locally, you have `Screen Sharing` app installed by default.

When connected to the instance, you have to enter username and password as below:

* username: ec2-user
* password: the password you entered on step 2

If you want to change the screen resolution, please refer to this document: [Modify macOS screen resolution on Mac instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html#mac-screen-resolution)

### 5. Install Xcode
You need Xcode installed for building iOS apps. Follow this instruction ([Install Xcode and accept license](https://catalog.us-east-1.prod.workshops.aws/workshops/43e96ac6-6d4f-4d99-af97-3ac2a5987391/en-US/020-build-farms/060-labs-unity-mac/015-environment-and-ec2-mac/040-ec2-mac-setup/040-install-xcode-and-accept-license)
) and complete the installation:

1. Install Xcode (You have to login to your Apple account)
2. Launch Xcode and approve the license

### 6. (Optional) Create an AMI
You do not have to repeat all the steps above every time you provisioned new mac instances.
Instead, you can create an [Amazon Machine Image (AMI)](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AMIs.html) from your existing instance and reuse it when launching another instance.

To create an AMI, please follow this document: [Create an AMI from an Amazon EC2 Instance](https://docs.aws.amazon.com/toolkit-for-visual-studio/latest/user-guide/tkv-create-ami-from-instance.html). When you create an AMI, you can toggle `No reboot` checkbox, but it is recommended to keep it unchecked because `No reboot` sometimes results in unstable behavior. It usually takes about an hour to create an AMI from a mac instance.

After AMI creation, you can use the AMI to launch another mac instance. See the below CDK code for reference:

```ts
new AgentMac(this, 'JenkinsMacAgent2', {
  vpc,
  sshKeyName: keyPair.keyPairName,
  availabilityZone: vpc.privateSubnets[0].availabilityZone,
  // replace amiId with the AMI ID you created
  amiId: 'ami-xxxxxxxxxxx',
  artifactBucket,
  storageSizeGb: 200,
  instanceType: 'mac1.metal',
});
```

Note that you do not have to change AMI for the existing mac instance.

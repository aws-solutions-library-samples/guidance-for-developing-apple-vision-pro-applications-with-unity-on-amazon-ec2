## Automatically update AMI for build agents
Since EC2 Linux Spot instances are stateless, all the internal states of an instance (e.g. filesystem) are purged when an instance is terminated (e.g. by scaling activities.) This can slow down build processes because many build systems rely on caches of intermediate artifacts in a build server's filesystem, assuming that they are shared between build jobs, which is not always the case on stateless servers.

However, we can share these caches between build jobs even in our Linux spot based system by using [Amazon Machine Images (AMI)](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AMIs.html).
An AMI contains a snapshot of the filesystem of an instance ([Amazon EBS](https://aws.amazon.com/ebs/) snapshot.) If we create an AMI from an existing EC2 instance that was previously used for a Unity build job, any instance launched from the AMI will have warmed caches ready as soon as it is initialized.We can even create AMIs periodically to keep the caches updated.
By using AMIs, it is possible to overcome the drawbacks of stateless instances and make the build process fast as if they were stateful.

When creating an AMI from a build server, we need to be careful about the following facts:

1. An instance should be rebooted when an AMI is created from it to ensure the consistency of the snapshot ([doc](https://docs.aws.amazon.com/toolkit-for-visual-studio/latest/user-guide/tkv-create-ami-from-instance.html))
2. An instance must not belong to an auto scaling group, since it can be terminated by the ASG when it is rebooted.
3. During AMI creation, a Unity build job should not be running on the instance. This may break the cache consistency.
4. During AMI creation, [spot interruption](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html) can happen to the instance, causing the build to fail. To mitigate this, we need a retry mechanism.

With all of the above in mind, we include a sample Jenkins job to periodically create and update AMIs for Linux Jenkins agents.

![AMI workflow](docs/imgs/ami-workflow.svg)

The `detachFromAsg` job is intended to be called periodically (e.g. by using [Jenkins cron job](https://www.jenkins.io/doc/book/pipeline/syntax/#cron-syntax)) and will attempt to create an AMI and update the ASG as needed. You can reference the implementation and integrate it into your own build system.

The disadvantage of using AMI for caching, however, is that it takes some time to fully fetch (hydrate) EBS snapshots, resulting in higher I/O latency during the hydration. In some situations, the hydration process takes too long to be used as a cache. One solution to this the problem is to use the Fast Snapshot Restore feature, which allows the volume to be hydrated immediately without much I/O latency ([Addressing I/O latency when restoring Amazon EBS volumes from EBS Snapshots](https://aws.amazon.com/blogs/storage/addressing-i-o-latency-when-restoring-amazon-ebs-volumes-from-ebs-snapshots/)).

Note that if you are using FSR, you should be aware of [volume creation credits](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-fast-snapshot-restore.html#volume-creation-credits) and [additional charges](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-fast-snapshot-restore.html#fsr-pricing).

There is another way to avoid this problem and solve the caching problem at the same time, which is described in the README.md (EBS volume pool).

The latest version does not include the job definition to update AMI, preferring EBS volume pool solution.

Please refer to [`create_ami` tag](https://github.com/aws-samples/jenkins-unity-build-on-aws/tree/create_ami) for the actual implementation.

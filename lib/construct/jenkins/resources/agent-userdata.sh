yum update -y
yum install -y git jq

# allow to use /data even if no data volume is configured
JENKINS_DIR="/data"
mkdir $JENKINS_DIR
chmod 777 $JENKINS_DIR

# mount a data volume 
TOKEN=`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600"`
AZ=`curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .availabilityZone`
INSTANCE_ID=`curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id`
REGION=`curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/placement/region`
# find a volume with the same kind tag as the instance
# choose a random volume to use evenly across all volumes of the same kind
VOLUME_ID=$(aws ec2 describe-volumes --filters Name=tag:Kind,Values=<KIND_TAG> Name=availability-zone,Values=$AZ Name=status,Values=available --query 'Volumes[*].[VolumeId]' --output text --region $REGION | shuf | head -1)

if [ "$VOLUME_ID" ];then
    echo "found volume $VOLUME_ID"
    DEVICE_NAME="/dev/xvdf"
    aws ec2 attach-volume --device $DEVICE_NAME --instance-id $INSTANCE_ID --volume-id $VOLUME_ID --region $REGION
    if [ $? -ne 0 ]; then
        # There is possibly a race condition between other instances (e.g. the volume is occupied by another instance).
        # Terminate the instance if attaching volume failed. ASG will retry booting an instance.
        shutdown now -h
    fi

    # we should do polling for the volume status instead, but it usually finishes in a few seconds...
    sleep 10

    # basically following this doc: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-using-volumes.html
    VNAME=$(readlink $DEVICE_NAME)
    RES=$(file -s /dev/$VNAME)

    if [[ "$RES" =~ .*": data" ]]; then
        # If the volume is not formatted yet
        mkfs -t xfs $DEVICE_NAME
    fi

    mount $DEVICE_NAME $JENKINS_DIR
    chmod 777 $JENKINS_DIR

    UUID=$(blkid | grep $VNAME | sed 's/.*UUID="\(\S*\)"\s.*/\1/')
    printf "\nUUID=${UUID}  ${JENKINS_DIR}  xfs  defaults,nofail  0  2\n" >> /etc/fstab
fi

# install docker
yum install -y docker
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user
chmod 777 /var/run/docker.sock

# install git lfs
# install java after data volume is set up to avoid jenkins agent configured before /data is mounted
# Set os/dist explicitly https://github.com/git-lfs/git-lfs/issues/5356
curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | os=fedora dist=36 bash
yum install -y java-17-amazon-corretto-headless git-lfs

# install tools for debug
yum install -y tmux htop

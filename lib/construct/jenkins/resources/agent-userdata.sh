# update AWS CLI to v2
rm -rf /usr/local/aws
rm /usr/local/bin/aws
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip -q -o awscliv2.zip
./aws/install

yum update -y
yum install -y git jq

# allow to use /data even if no data volume is configured
JENKINS_DIR="/data"
mkdir $JENKINS_DIR
chmod 777 $JENKINS_DIR

# mount a data volume 
AZ=$(curl -s http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .availabilityZone)
INSTANCE_ID=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(wget -q -O - http://169.254.169.254/latest/meta-data/placement/region)
VOLUME_ID=$(aws ec2 describe-volumes --filters Name=tag:Kind,Values=<KIND_TAG> Name=availability-zone,Values=$AZ Name=status,Values=available --query 'Volumes[0].VolumeId' --output text --region $REGION)

if [ "$VOLUME_ID" ];then
    echo "found volume ${VOLUME}"
    DEVICE_NAME="/dev/xvdf"
    # There is possibly a race condition between other instances.
    # We may want to retry attach-volume according to the return code (currently omitted).
    aws ec2 attach-volume --device $DEVICE_NAME --instance-id $INSTANCE_ID --volume-id $VOLUME_ID --region $REGION
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

    UUID=$(blkid | grep $VNAME | sed 's/.*UUID="\(.*\)"\s.*/\1/')
    printf "\nUUID=${UUID}  ${JENKINS_DIR}  xfs  defaults,nofail  0  2\n" >> /etc/fstab
fi

# install docker
yum install -y docker
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user
chmod 777 /var/run/docker.sock

# install git lfs
# install java after data volume is set up to avoid jenkis agent configured too quickly
curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | bash
yum install -y java-17-amazon-corretto-headless git-lfs

# install tools for debug
yum install -y tmux htop

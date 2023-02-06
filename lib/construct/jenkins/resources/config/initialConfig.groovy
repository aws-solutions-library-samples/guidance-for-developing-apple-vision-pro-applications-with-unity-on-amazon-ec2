import jenkins.install.InstallState
import com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey.DirectEntryPrivateKeySource
import com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey
import com.cloudbees.jenkins.plugins.awscredentials.AWSCredentialsImpl
import com.cloudbees.plugins.credentials.*
import com.cloudbees.plugins.credentials.domains.Domain
import hudson.model.*
import jenkins.model.Jenkins
import jenkins.model.JenkinsLocationConfiguration

// You can change Jenkins timezone here
// System.setProperty('org.apache.commons.jelly.tags.fmt.timeZone', 'Asia/Tokyo')

def key = System.env.PRIVATE_KEY

// https://plugins.jenkins.io/ec2-fleet/#plugin-content-groovy
BasicSSHUserPrivateKey instanceCredentials = new BasicSSHUserPrivateKey(
  CredentialsScope.GLOBAL,
  'instance-ssh-key',
  'ec2-user',
  new DirectEntryPrivateKeySource(key),
  '',
  'private key to ssh ec2 for jenkins'
)

// https://github.com/jenkinsci/aws-credentials-plugin/blob/master/src/main/java/com/cloudbees/jenkins/plugins/awscredentials/AWSCredentialsImpl.java
AWSCredentialsImpl awsCredential = new AWSCredentialsImpl(
  CredentialsScope.GLOBAL,
  'ecr-role',
  '',
  '',
  'IAM role arn used for Amazon ECR plugin',
  System.env.ECR_ROLE_ARN,
  '',
  ''
)

// get Jenkins instance
Jenkins jenkins = Jenkins.get()
// get credentials domain
def domain = Domain.global()
// get credentials store
def store = jenkins.getExtensionList('com.cloudbees.plugins.credentials.SystemCredentialsProvider')[0].getStore()
// add credential to store
store.addCredentials(domain, instanceCredentials)
store.addCredentials(domain, awsCredential)
// save current Jenkins state to disk
jenkins.save()

Jenkins.instance.setInstallState(InstallState.INITIAL_SETUP_COMPLETED)

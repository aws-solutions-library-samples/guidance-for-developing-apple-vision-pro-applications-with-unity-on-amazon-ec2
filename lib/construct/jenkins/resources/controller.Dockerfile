FROM --platform=linux/x86_64 jenkins/jenkins:lts-jdk17
ARG CONFIG_FILE_NAME='jenkins.TestStack.yaml'

# https://github.com/jenkinsci/docker

# https://github.com/jenkinsci/plugin-installation-manager-tool
COPY config/plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --latest false --plugin-file /usr/share/jenkins/ref/plugins.txt

# post initilization script https://www.jenkins.io/doc/book/managing/groovy-hook-scripts/
COPY config/initialConfig.groovy /usr/share/jenkins/ref/init.groovy.d/InitialConfig.groovy.override

# Configuration as code https://plugins.jenkins.io/configuration-as-code/
COPY config/$CONFIG_FILE_NAME /usr/share/jenkins/ref/jenkins.yaml.override

# Sample Jobs
COPY config/agentTestJob.xml /usr/share/jenkins/ref/jobs/agent-test/config.xml.override

ENV JAVA_OPTS -Djenkins.install.runSetupWizard=false

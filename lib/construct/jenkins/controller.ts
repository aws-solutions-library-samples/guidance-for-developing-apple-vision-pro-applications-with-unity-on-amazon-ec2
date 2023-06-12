import { Construct } from 'constructs';
import * as efs from 'aws-cdk-lib/aws-efs';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ApplicationProtocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { AccountRootPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { join } from 'path';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import { Cluster } from 'aws-cdk-lib/aws-ecs';
import * as ejs from 'ejs';
import { writeFileSync } from 'fs';

export interface MacAgentProps {
  readonly ipAddress: string;
  readonly name: string;
  readonly sshCredentialsId: string;
}

export interface EC2FleetAgentProps {
  readonly fleetAsgName: string;
  readonly fleetMinSize: number;
  readonly fleetMaxSize: number;

  readonly label: string;
  readonly name: string;
  readonly launchTemplateId?: string;
  readonly sshCredentialsId: string;
  readonly fsRoot: string;

  readonly sshConnectTimeoutSeconds: number;
  readonly sshConnectMaxNumRetries: number;
  readonly sshConnectRetryWaitTime: number;

  readonly prefixStartSlaveCmd?: string;
  readonly suffixStartSlaveCmd?: string;
}

export interface ControllerProps {
  readonly vpc: IVpc;
  readonly logBucket: IBucket;
  readonly artifactBucket: IBucket;
  readonly environmentVariables: { [key: string]: string };
  readonly environmentSecrets: { [key: string]: ecs.Secret };
  readonly allowedCidrs?: string[];
  readonly certificateArn?: string;
  readonly containerRepository?: IRepository;
  readonly macAgents?: MacAgentProps[];
  readonly ec2FleetAgents?: EC2FleetAgentProps[];
}

/**
 * EC2 Auto Scaling Group for Jenkins controller.
 * The number of instances is fixed to one since Jenkins does not support horizontal scaling.
 */
export class Controller extends Construct {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ControllerProps) {
    super(scope, id);

    const { macAgents = [], ec2FleetAgents = [] } = props;

    const { vpc, allowedCidrs = [] } = props;
    allowedCidrs.push(vpc.vpcCidrBlock);

    const cluster = new Cluster(this, 'Cluster', {
      vpc,
      containerInsights: true,
    });

    const fileSystem = new efs.FileSystem(this, 'Storage', {
      vpc,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const protocol = props.certificateArn != null ? ApplicationProtocol.HTTPS : ApplicationProtocol.HTTP;

    let certificate = undefined;
    if (props.certificateArn != null) {
      certificate = Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);
    }

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    const fleetAsgNameEnv = (agent: { name: string }) =>
      `FLEET_ASG_NAME_${agent.name.toUpperCase().replace(/-/g, '_')}`;

    const fleetLaunchTemplateIdEnv = (agent: { name: string }) =>
      `FLEET_LAUNCH_TEMPLATE_ID_${agent.name.toUpperCase().replace(/-/g, '_')}`;

    const macHostEnv = (agent: { name: string }) => `MAC_HOST_${agent.name.toUpperCase().replace(/-/g, '_')}`;

    const exportingEnvironment = {
      ...props.environmentVariables,
      AWS_REGION: Stack.of(this).region,
      ARTIFACT_BUCKET_NAME: props.artifactBucket.bucketName,
      ...Object.fromEntries(
        ec2FleetAgents.flatMap((agent) => [
          [fleetAsgNameEnv(agent), agent.fleetAsgName],
          [fleetLaunchTemplateIdEnv(agent), agent.launchTemplateId],
        ]),
      ),
      // We need these values when we use a Docker Image from ECR repository for a Jenkins Docker Agent
      // https://itnext.io/how-to-run-jenkins-agents-with-cross-account-ecr-images-using-instance-roles-on-eks-2544b0fc6819
      ECR_REPOSITORY_URL: props.containerRepository?.repositoryUri ?? '',
      ECR_REGISTRY_URL: `https://${Stack.of(this).account}.dkr.ecr.${Stack.of(this).region}.amazonaws.com`,
    };

    // avoid from overwriting jenkins.yaml of other stacks
    const configOutputFilename = `jenkins.${Stack.of(this).stackName}.yaml`;
    ejs.renderFile(
      join(__dirname, 'resources', 'config', 'jenkins.yaml.ejs'),
      {
        env: [...Object.keys(exportingEnvironment)],
        macAgents: macAgents.map((agent) => ({
          ...agent,
          macHostEnv: macHostEnv(agent),
        })),
        ec2FleetAgents: ec2FleetAgents.map((agent) => ({
          ...agent,
          fleetAsgNameEnv: fleetAsgNameEnv(agent),
        })),
      },
      {},
      function (err, str) {
        writeFileSync(join(__dirname, 'resources', 'config', configOutputFilename), str);
      },
    );

    const container = taskDefinition.addContainer('main', {
      image: ecs.ContainerImage.fromAsset(join(__dirname, 'resources'), {
        file: 'controller.Dockerfile',
        platform: Platform.LINUX_AMD64,
        buildArgs: {
          CONFIG_FILE_NAME: configOutputFilename,
        },
      }),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'jenkins-controller',
        logRetention: RetentionDays.SIX_MONTHS,
      }),
      portMappings: [
        {
          // for jenkins web UI
          containerPort: 8080,
        },
      ],
      linuxParameters: new ecs.LinuxParameters(this, 'LinuxParameters', {
        initProcessEnabled: true,
      }),
      environment: {
        ...exportingEnvironment,
        PLUGINS_FORCE_UPGRADE: 'true',
        ECR_ROLE_ARN: taskDefinition.taskRole.roleArn,
        ...Object.fromEntries(macAgents.flatMap((agent) => [[macHostEnv(agent), agent.ipAddress]])),
      },
      secrets: {
        ...props.environmentSecrets,
      },
    });

    const controller = new ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      // We only need just one instance for Jenkins controller
      desiredCount: 1,
      targetProtocol: ApplicationProtocol.HTTP,
      openListener: false,
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskDefinition: taskDefinition,
      healthCheckGracePeriod: Duration.seconds(60),
      protocol,
      certificate,
      sslPolicy: protocol == ApplicationProtocol.HTTPS ? SslPolicy.RECOMMENDED : undefined,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: true,
    });

    container.addEnvironment(
      'JENKINS_URL',
      `${protocol.toLowerCase()}://${controller.loadBalancer.loadBalancerDnsName}`,
    );

    // https://github.com/aws/aws-cdk/issues/4015
    controller.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '10');

    controller.targetGroup.configureHealthCheck({
      interval: Duration.seconds(15),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 4,
      healthyHttpCodes: '200',
      path: '/login', // https://devops.stackexchange.com/a/9178
    });

    // https://plugins.jenkins.io/ec2-fleet/#plugin-content-3-configure-user-permissions
    taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: [
          'ec2:DescribeSpotFleetInstances',
          'ec2:ModifySpotFleetRequest',
          'ec2:CreateTags',
          'ec2:DescribeRegions',
          'ec2:DescribeInstances',
          'ec2:TerminateInstances',
          'ec2:DescribeInstanceStatus',
          'ec2:DescribeSpotFleetRequests',
          'autoscaling:DescribeAutoScalingGroups',
          'autoscaling:UpdateAutoScalingGroup',
          'iam:ListInstanceProfiles',
          'iam:ListRoles',
        ],
        resources: ['*'],
      }),
    );

    taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [taskDefinition.taskRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': ['ec2.amazonaws.com'],
          },
        },
      }),
    );

    props.containerRepository?.grantPull(taskDefinition.taskRole);
    props.artifactBucket.grantReadWrite(taskDefinition.taskRole);
    taskDefinition.taskRole.grantAssumeRole(taskDefinition.taskRole);

    // When Jenkins accesses an ECR repository, it tries to assume this role.
    // To allow the action, we want to specify the role session name as a principal, but it is not possible
    // because ECS uses a random name for the session. We are not allowed to use a wildcard here.
    // As a workaround, we use AccountRoot principal here.
    // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html#principal-role-session
    (taskDefinition.taskRole as Role).assumeRolePolicy!.addStatements(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        principals: [new AccountRootPrincipal()],
      }),
    );

    const port = protocol == ApplicationProtocol.HTTPS ? 443 : 80;
    allowedCidrs.forEach((cidr) => {
      controller.loadBalancer.connections.allowFrom(ec2.Peer.ipv4(cidr), ec2.Port.tcp(port));
    });

    controller.loadBalancer.logAccessLogs(props.logBucket, 'jenkinsAlbAccessLog');

    fileSystem.connections.allowDefaultPortFrom(controller.service.connections);

    // https://docs.aws.amazon.com/efs/latest/ug/accessing-fs-nfs-permissions.html
    // https://aws.amazon.com/blogs/containers/developers-guide-to-using-amazon-efs-with-amazon-ecs-and-aws-fargate-part-2/
    const efsAccessPoint = fileSystem.addAccessPoint('AccessPoint', {
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      path: '/jenkins-home',
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
    });

    fileSystem.grant(
      taskDefinition.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
      'elasticfilesystem:ClientRootAccess',
    );

    const volumeName = 'shared';

    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: efsAccessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    container.addMountPoints({
      // https://jenkins-le-guide-complet.github.io/html/sec-hudson-home-directory-contents.html
      containerPath: '/var/jenkins_home',
      sourceVolume: volumeName,
      readOnly: false,
    });

    this.service = controller.service;
  }
}

// cdk/lib/cdk-stack.ts
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { InstanceClass, InstanceSize, InstanceType, Port, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2"; // prettier-ignore
import { CpuArchitecture, EcrImage, OperatingSystemFamily, Secret } from "aws-cdk-lib/aws-ecs"; // prettier-ignore
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { AuroraPostgresEngineVersion, ClusterInstance, DatabaseCluster, DatabaseClusterEngine, InstanceUpdateBehaviour, } from 'aws-cdk-lib/aws-rds'; // prettier-ignore
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { join } from 'path';

export interface CdkStackProps extends StackProps {}

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props: CdkStackProps) {
    super(scope, id, props);

    // ローカルにあるイメージをECRにpushする(引数にDockerfileまでのパスを渡す)
    const image = EcrImage.fromAsset(join(__dirname, '../../'));

    const vpcId = process.env.VPC_ID ?? new Error('VPC_ID is not defined');
    const subDomain = process.env.USER?.toLowerCase() ?? new Error('USER is not defined');
    const domainName = process.env.DOMAIN_NAME ?? new Error('DOMAIN_NAME is not defined');
    const certificateArn = process.env.CERTIFICATE_ARN ?? new Error('CERTIFICATE_ARN is not defined');

    if (vpcId instanceof Error) throw vpcId;
    if (subDomain instanceof Error) throw subDomain;
    if (domainName instanceof Error) throw domainName;
    if (certificateArn instanceof Error) throw certificateArn;

    const rds = new DatabaseCluster(this, DatabaseCluster.name, {
      vpc: Vpc.fromLookup(this, Vpc.name, { vpcId }),
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_15_3,
      }),
      instanceUpdateBehaviour: InstanceUpdateBehaviour.ROLLING,
      writer: ClusterInstance.provisioned('WriterInstanceT3Medium', {
        instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
        enablePerformanceInsights: true,
      }),
      readers: [
        ClusterInstance.provisioned('ReaderInstanceT3Medium', {
          instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
          enablePerformanceInsights: true,
        }),
      ],
      defaultDatabaseName: 'zon100',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    if (!rds.secret) return;

    // レベル1~3まであり、数字が大きくなると抽象度が上がる(数字が小さいほど、カスタマイズ性が高くなる)
    const { targetGroup, service, taskDefinition } = new ApplicationLoadBalancedFargateService(
      this,
      ApplicationLoadBalancedFargateService.name,
      {
        vpc: rds.vpc,
        taskImageOptions: {
          image,
          command: ['bun', 'run', 'start'],
          containerPort: 3000,
          secrets: {
            // secrets managerから取得(Auroraなので、自動で設定されるやつを使っている)
            DB_HOST: Secret.fromSecretsManager(rds.secret, 'host'),
            DB_PORT: Secret.fromSecretsManager(rds.secret, 'port'),
            DB_USER: Secret.fromSecretsManager(rds.secret, 'username'),
            DB_PASS: Secret.fromSecretsManager(rds.secret, 'password'),
            DB_NAME: Secret.fromSecretsManager(rds.secret, 'dbname'),
          },
        },
        domainName: `${subDomain}.${domainName}`,
        domainZone: HostedZone.fromLookup(this, 'HostedZone', { domainName }),
        certificate: Certificate.fromCertificateArn(this, Certificate.name, certificateArn),
        redirectHTTP: true,
        // 10回デプロイ失敗すると、ロールバックする
        circuitBreaker: { rollback: true },
        // コンテナに直接アタッチする
        enableExecuteCommand: true,
        // apple silicon mac　で docker build の方は下記を追加
        runtimePlatform: {
          cpuArchitecture: CpuArchitecture.ARM64,
          operatingSystemFamily: OperatingSystemFamily.LINUX,
        },
      }
    );

    targetGroup.configureHealthCheck({
      port: `${taskDefinition.defaultContainer?.containerPort}`,
      path: '/',
    });

    rds.connections.allowFrom(service, Port.tcp(rds.clusterEndpoint.port));
  }
}

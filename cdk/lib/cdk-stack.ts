import { Stack, StackProps } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Vpc } from "aws-cdk-lib/aws-ec2"; // prettier-ignore
import { CpuArchitecture, EcrImage, OperatingSystemFamily } from "aws-cdk-lib/aws-ecs"; // prettier-ignore
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
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

    // レベル1~3まであり、数字が大きくなると抽象度が上がる(数字が小さいほど、カスタマイズ性が高くなる)
    const { targetGroup, taskDefinition } = new ApplicationLoadBalancedFargateService(
      this,
      ApplicationLoadBalancedFargateService.name,
      {
        vpc: Vpc.fromLookup(this, Vpc.name, { vpcId }),
        taskImageOptions: {
          image,
          command: ['bun', 'run', 'start'],
          containerPort: 3000,
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
  }
}

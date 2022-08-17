const path = require('path');
const _ = require('lodash');
const chalk = require('chalk');
const yaml = require('js-yaml');
const fs = require('fs');

class ServerlessApiCloudFrontPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'package:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this),
      'aws:info:displayStackOutputs': this.printSummary.bind(this),
    };
  }

  createDeploymentArtifacts() {
    const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate;

    const filename = path.resolve(__dirname, 'resources.yml');
    const content = fs.readFileSync(filename, 'utf-8');
    const resources = yaml.safeLoad(content, {
      filename: filename
    });

    this.prepareResources(resources);

    if(this.serverless.service.provider.tags) {
      resources.Resources.ApiDistribution.Properties.Tags = Object.entries(this.serverless.service.provider.tags).map(x=> {
        return {
          Key: x[0],
          Value: x[1]
        }
      });
    }
    return _.merge(baseResources, resources);
  }

  printSummary() {
    const awsInfo = _.find(this.serverless.pluginManager.getPlugins(), (plugin) => {
      return plugin.constructor.name === 'AwsInfo';
    });

    if (!awsInfo || !awsInfo.gatheredData) {
      return;
    }

    const outputs = awsInfo.gatheredData.outputs;
    const apiDistributionDomain = _.find(outputs, (output) => {
      return output.OutputKey === 'ApiDistribution';
    });

    if (!apiDistributionDomain || !apiDistributionDomain.OutputValue) {
      return ;
    }

    const cnameDomain = this.getConfig('domain', '-');

    this.serverless.cli.consoleLog(chalk.yellow('CloudFront domain name'));
    this.serverless.cli.consoleLog(`  ${apiDistributionDomain.OutputValue} (CNAME: ${cnameDomain})`);
  }

  prepareResources(resources) {
    const distributionConfig = resources.Resources.ApiDistribution.Properties.DistributionConfig;

    this.prepareLogging(distributionConfig);
    this.prepareDomain(distributionConfig);
    this.preparePriceClass(distributionConfig);
    this.prepareOrigins(distributionConfig);
    this.preparePolicies(distributionConfig);
    this.prepareComment(distributionConfig);
    this.prepareCertificate(distributionConfig);
    this.prepareWaf(distributionConfig);
    this.prepareMinimumProtocolVersion(distributionConfig);
    this.prepareCompress(distributionConfig);

    const customDomainNameProperties = resources.Resources.CustomDomainName.Properties;
    this.prepareCustomDomainName(customDomainNameProperties);

    const apiMappingProperties = resources.Resources.ApiMapping.Properties;
    this.prepareApiMapping(apiMappingProperties);

    this.prepareRoute53Record(resources);
  }

  prepareCustomDomainName(customDomainNameProperties) {
    const domain = this.getConfig('domain', null);
    const regionalCertificate = this.getConfig('regionalCertificate', null);
    customDomainNameProperties.DomainName = domain;
    customDomainNameProperties.DomainNameConfigurations[0].CertificateArn = regionalCertificate;
    customDomainNameProperties.Tags = this.serverless.service.provider.tags;
  }

  prepareApiMapping(apiMappingProperties) {
    const domain = this.getConfig('domain', null);
    apiMappingProperties.DomainName = domain;
    const websocket = this.getConfig("websocket", false);
    if (websocket) {
      apiMappingProperties.ApiId.Ref = "WebsocketsApi";
      apiMappingProperties.Stage.Ref = "WebsocketsDeploymentStage";
    }
  }

  prepareRoute53Record(resources) {
    if (this.getConfig('route53', false)) {
      const domain = this.getConfig('domain', null);
      const hostedZoneName = `${domain.split(".").slice(1).join(".")}.`;
      resources.Resources.Route53RecordA = {
        Type: "AWS::Route53::RecordSet",
        Properties:{
           HostedZoneName: hostedZoneName,
           Name: domain,
           Type: "A",
           AliasTarget: {
             HostedZoneId: "Z2FDTNDATAQYW2",
             DNSName:{
               "Fn::GetAtt": [ "ApiDistribution", "DomainName" ]
              },
             EvaluateTargetHealth: true
          }
        }
      }
      resources.Resources.Route53RecordAAAA = {
        Type: "AWS::Route53::RecordSet",
        Properties:{
           HostedZoneName: hostedZoneName,
           Name: domain,
           Type: "AAAA",
           AliasTarget: {
             HostedZoneId: "Z2FDTNDATAQYW2",
             DNSName:{
               "Fn::GetAtt": [ "ApiDistribution", "DomainName" ]
              },
             EvaluateTargetHealth: true
          }
        }
      }
    }
  }

  prepareLogging(distributionConfig) {
    const loggingBucket = this.getConfig('logging.bucket', null);
    if (loggingBucket !== null) {
      distributionConfig.Logging.Bucket = loggingBucket;
      distributionConfig.Logging.Prefix = this.getConfig('logging.prefix', '');

    } else {
      delete distributionConfig.Logging;
    }
  }

  prepareDomain(distributionConfig) {
    const domain = this.getConfig('domain', null);
    if (domain !== null) {
      distributionConfig.Aliases = Array.isArray(domain) ? domain : [ domain ];
    } else {
      delete distributionConfig.Aliases;
    }
  }

  preparePriceClass(distributionConfig) {
    const priceClass = this.getConfig('priceClass', 'PriceClass_All');
    distributionConfig.PriceClass = priceClass;
  }

  prepareOrigins(distributionConfig) {
    const origin = _.head(distributionConfig.Origins)
    const originCustomHeaders = this.getConfig('originCustomHeaders', [])

    origin.OriginCustomHeaders = originCustomHeaders
      .map(_.toPairs)
      .map(_.head)
      .map(_.partial(_.zipObject, ['HeaderName', 'HeaderValue']))
   }

  preparePolicies(distributionConfig) {
    const cachePolicyId = this.getConfig('cachePolicyId', null);
    if (cachePolicyId) {
      distributionConfig.DefaultCacheBehavior.CachePolicyId = cachePolicyId;
    }

    const originRequestPolicyId = this.getConfig('originRequestPolicyId', null);
    if (originRequestPolicyId) {
      distributionConfig.DefaultCacheBehavior.OriginRequestPolicyId = originRequestPolicyId;
    }

    const responseHeadersPolicyId = this.getConfig('responseHeadersPolicyId', null);
    if (responseHeadersPolicyId) {
      distributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId = responseHeadersPolicyId;
    }
  }

  prepareCompress(distributionConfig) {
    distributionConfig.DefaultCacheBehavior.Compress = (this.getConfig('compress', true) === true) ? true : false;
  }

  prepareComment(distributionConfig) {
    const name = this.serverless.getProvider('aws').naming.getApiGatewayName();
    distributionConfig.Comment = `Serverless Managed ${name}`;
  }

  prepareCertificate(distributionConfig) {
    const certificate = this.getConfig('certificate', null);
    if (certificate !== null) {
      distributionConfig.ViewerCertificate.AcmCertificateArn = certificate;
    } else {
      delete distributionConfig.ViewerCertificate;
    }
  }

  prepareWaf(distributionConfig) {
    const waf = this.getConfig('waf', null);
    if (waf !== null) {
      distributionConfig.WebACLId = waf;
    } else {
      delete distributionConfig.WebACLId;
    }
  }

  prepareMinimumProtocolVersion(distributionConfig) {
    const minimumProtocolVersion = this.getConfig('minimumProtocolVersion', undefined);
    if (minimumProtocolVersion) {
      distributionConfig.ViewerCertificate.MinimumProtocolVersion = minimumProtocolVersion;
    }
  }

  getConfig(field, defaultValue) {
    return _.get(this.serverless, `service.custom.apiCloudFront.${field}`, defaultValue)
  }
}

module.exports = ServerlessApiCloudFrontPlugin;

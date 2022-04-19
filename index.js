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
    this.prepareCookies(distributionConfig);
    this.prepareHeaders(distributionConfig);
    this.prepareTTL(distributionConfig);
    this.preparePolicies(distributionConfig);
    this.prepareQueryString(distributionConfig);
    this.prepareComment(distributionConfig);
    this.prepareCertificate(distributionConfig);
    this.prepareWaf(distributionConfig);
    this.prepareCompress(distributionConfig);
    this.prepareMinimumProtocolVersion(distributionConfig);

    const customDomainProperties = resources.Resources.CustomDomainName.Properties;
    this.prepareCustomDomain(customDomainProperties);

    const apiMappingProperties = resources.Resources.ApiMapping.Properties;
    this.prepareApiMapping(apiMappingProperties);
  }

  prepareCustomDomain(customDomainProperties) {
    const domain = this.getConfig('domain', null);
    const regionalCertificate = this.getConfig('regionalCertificate', null);
    customDomainProperties.DomainName = domain;
    customDomainProperties.DomainNameConfigurations.CertificateArn = regionalCertificate;
  }

  prepareApiMapping(apiMappingProperties) {
    const domain = this.getConfig('domain', null);
    apiMappingProperties.DomainName = domain;
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


    // const httpApi = this.getConfig("httpApi", false);
    // const websocketApi = this.getConfig("websocketApi", false);
    // let ref = "ApiGatewayRestApi";
    // if (httpApi) {
    //   ref = "HttpApi"
    // } else if (websocketApi) {
    //   ref = "WebsocketsApi"
    // }
    // distributionConfig.Origins[0].DomainName = {
    //   "Fn::Join": [
    //     "",
    //     [
    //       {
    //         Ref: ref
    //       },
    //       ".execute-api.",
    //       {
    //         "Ref": "AWS::Region"
    //       },
    //       ".amazonaws.com"
    //     ]
    //   ]
    // }
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
    // origin.OriginPath = `/${this.options.stage}`;
    
    // const httpApi = this.getConfig("httpApi", false);
    // distributionConfig.Origins[0].OriginPath = httpApi ? "" : `/${this.options.stage}`;
  }

  prepareCookies(distributionConfig) {
      const forwardCookies = this.getConfig('cookies', 'all');
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Cookies.Forward = Array.isArray(forwardCookies) ? 'whitelist' : forwardCookies;
      if (Array.isArray(forwardCookies)) {
        distributionConfig.DefaultCacheBehavior.ForwardedValues.Cookies.WhitelistedNames = forwardCookies;
      }
  }
  
  prepareHeaders(distributionConfig) {
      const forwardHeaders = this.getConfig('headers', 'none');
      
      if (Array.isArray(forwardHeaders)) {
        distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = forwardHeaders;
      } else {
        distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = forwardHeaders === 'none' ? [] : ['*'];
      }
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
    }

  prepareTTL(distributionConfig) {
    const ttl = this.getConfig('ttl', null);

    if (ttl) {
      distributionConfig.DefaultCacheBehavior.DefaultTTL = ttl.default;
      distributionConfig.DefaultCacheBehavior.MaxTTL = ttl.max;
      distributionConfig.DefaultCacheBehavior.MinTTL = ttl.min;
    }
  }

  prepareQueryString(distributionConfig) {
        const forwardQueryString = this.getConfig('querystring', 'all');
        
        if (Array.isArray(forwardQueryString)) {
          distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryString = true;
          distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryStringCacheKeys = forwardQueryString;
        } else {
          distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryString = forwardQueryString === 'all' ? true : false;
        }
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
  
  prepareCompress(distributionConfig) {
    distributionConfig.DefaultCacheBehavior.Compress = (this.getConfig('compress', false) === true) ? true : false;
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

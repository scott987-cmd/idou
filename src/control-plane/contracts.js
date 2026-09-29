/**
 * Control-plane contracts. Implementations must never accept source document,
 * knowledge-shard, generated-image, or generated-video bytes for persistence.
 */
export class AgentIdentityService {
  async beginFeishuLogin(_redirectUri, _devicePublicKey) {
    throw new Error("AgentIdentityService.beginFeishuLogin must be implemented");
  }

  async completeFeishuLogin(_authorizationCode, _state) {
    throw new Error("AgentIdentityService.completeFeishuLogin must be implemented");
  }

  async issueAgentToken(_deviceSession, _audience, _scopes) {
    throw new Error("AgentIdentityService.issueAgentToken must be implemented");
  }
}

export class SkillCatalogService {
  async list(_tenantId, _clientCapabilities) {
    throw new Error("SkillCatalogService.list must be implemented");
  }

  async getSignedBundle(_skillId, _version) {
    throw new Error("SkillCatalogService.getSignedBundle must be implemented");
  }
}

export class ModelGateway {
  async createResponse(_agentToken, _request) {
    throw new Error("ModelGateway.createResponse must be implemented");
  }
}


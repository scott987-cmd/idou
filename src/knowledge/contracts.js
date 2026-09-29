/**
 * Provider-neutral contracts for the distributed local knowledge system.
 * Implementations arrive in the indexing milestone; application code depends
 * on these shapes rather than on Feishu or a particular vector database.
 */

/**
 * @typedef {object} SourceDocument
 * @property {string} tenantId
 * @property {string} providerId
 * @property {string} resourceType
 * @property {string} resourceId
 * @property {string} revision
 * @property {string} title
 * @property {string} content
 * @property {string[]} aclSubjects
 * @property {string} sourceUrl
 */

/**
 * @typedef {object} KnowledgeHit
 * @property {string} documentId
 * @property {string} chunkId
 * @property {number} score
 * @property {string} text
 * @property {string} sourceUrl
 * @property {string} revision
 */

export class KnowledgeSourceProvider {
  async listChanges(_cursor) {
    throw new Error("KnowledgeSourceProvider.listChanges must be implemented");
  }

  async fetchDocument(_resourceId) {
    throw new Error("KnowledgeSourceProvider.fetchDocument must be implemented");
  }

  async canRead(_resourceId, _principal) {
    throw new Error("KnowledgeSourceProvider.canRead must be implemented");
  }
}

export class LocalKnowledgeIndex {
  async upsert(_document) {
    throw new Error("LocalKnowledgeIndex.upsert must be implemented");
  }

  async remove(_documentId) {
    throw new Error("LocalKnowledgeIndex.remove must be implemented");
  }

  async search(_query, _principal, _limit) {
    throw new Error("LocalKnowledgeIndex.search must be implemented");
  }
}

export class KnowledgeCoordinator {
  async acquireLease(_nodeId, _capabilities) {
    throw new Error("KnowledgeCoordinator.acquireLease must be implemented");
  }

  async publishManifest(_leaseId, _manifest) {
    throw new Error("KnowledgeCoordinator.publishManifest must be implemented");
  }

  async routeQuery(_queryEnvelope) {
    throw new Error("KnowledgeCoordinator.routeQuery must be implemented");
  }
}


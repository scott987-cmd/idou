/**
 * Images and videos use one asynchronous job contract. Provider credentials
 * stay behind the model gateway; durable output belongs in Feishu Drive.
 */
export class MediaGenerationGateway {
  async submit(_agentToken, _request) {
    throw new Error("MediaGenerationGateway.submit must be implemented");
  }

  async getJob(_agentToken, _jobId) {
    throw new Error("MediaGenerationGateway.getJob must be implemented");
  }

  async cancel(_agentToken, _jobId) {
    throw new Error("MediaGenerationGateway.cancel must be implemented");
  }
}

export function validateMediaRequest(request) {
  if (!request || !["image", "video"].includes(request.kind)) {
    throw new Error("media kind must be image or video");
  }
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    throw new Error("media prompt must be non-empty");
  }
  return { ...request, prompt: request.prompt.trim() };
}


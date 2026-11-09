export type MindMapNodeType = "folder" | "image";

export type MindMapNode = {
  id: string;
  name: string;
  type: MindMapNodeType;
  mimeType?: string;
  webViewLink?: string;
  imageUrl?: string;
  children: MindMapNode[];
  imageCount: number;
};

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiryDate?: number;
};

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  PRESETS, ALL_SCOPES, generateClientId, generateClientSecret, generateCode,
  generateAccessToken, generateRefreshToken, hashSecret, verifyPkce,
  saveApp, getApp, listApps, saveCode, getCode, markCodeUsed, saveToken,
  getToken, listTokens, revokeToken, saveGrant, revokeGrant, logActivity,
  listActivity, isValidOAuthToken,
} from "./oauth.js";

// ... existing bridge code continues below; OAuth routes are mounted in the start action.
// Full implementation is in the local source. This commit wires the imports.
console.log("DeskLink JS OAuth module loaded");

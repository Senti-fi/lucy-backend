import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { LUCY_SYSTEM_PROMPT, SUGGESTIONS_SYSTEM_PROMPT, ACTION_CHECK_PROMPT } from './prompts.js';

const app = express();
const port = process.env.PORT || 3001;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey || apiKey.trim() === '') {
  console.error('❌ ANTHROPIC_API_KEY is not set!');
  process.exit(1);
}

console.log('✅ Anthropic API key loaded');

const anthropic = new Anthropic({ apiKey });

const MODELS = {
  chat: 'claude-sonnet-4-20250514',
  suggestions: 'claude-haiku-4-20250514',
  actions: 'claude-haiku-4-20250514',
};

interface ChatMessage { type: 'user' | 'lucy'; text: string; }
interface WalletContext {
  totalBalance?: number;
  balances?: { usdc?: number; usdt?: number; sol?: number; };
  vaults?: Array<{ name: string; balance: number; apy: number; }>;
  savingsGoals?: Array<{ name: string; target: number; current: number; }>;
}

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://sentimobilewalletapp.vercel.app',
  'https://app.senti.finance',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.includes('vercel.app')) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'lucy-ai-backend', timestamp: new Date().toISOString() });
});

function buildSystemPrompt(walletContext?: WalletContext): string {
  if (walletContext && Object.keys(walletContext).length > 0) {
    return `${LUCY_SYSTEM_PROMPT}\n\nCURRENT WALLET CONTEXT:\n${JSON.stringify(walletContext, null, 2)}\n\nUse this context to personalize your responses.`;
  }
  return LUCY_SYSTEM_PROMPT;
}

function formatMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map(msg => ({
    role: msg.type === 'user' ? 'user' as const : 'assistant' as const,
    content: msg.text,
  }));
}

app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { messages, walletContext } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Messages array is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const systemPrompt = buildSystemPrompt(walletContext);
    const stream = await anthropic.messages.stream({
      model: MODELS.chat,
      max_tokens: 512,
      system: systemPrompt,
      messages: formatMessages(messages),
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ type: 'token', text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('Error in chat:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

app.post('/api/suggestions', async (req: Request, res: Response) => {
  try {
    const { lastMessage, walletContext } = req.body;
    if (!lastMessage) { res.status(400).json({ error: 'lastMessage is required' }); return; }

    const response = await anthropic.messages.create({
      model: MODELS.suggestions,
      max_tokens: 150,
      system: SUGGESTIONS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `User said: "${lastMessage}"\n\nWallet context: ${JSON.stringify(walletContext)}\n\nGenerate 2-3 follow-up suggestions (max 5 words each).` }],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      try { res.json({ suggestions: JSON.parse(content.text) }); }
      catch { res.json({ suggestions: [] }); }
    } else { res.json({ suggestions: [] }); }
  } catch (error: any) {
    console.error('Error suggestions:', error);
    res.json({ suggestions: [] });
  }
});

app.post('/api/check-action', async (req: Request, res: Response) => {
  try {
    const { message, walletContext } = req.body;
    if (!message) { res.status(400).json({ error: 'message is required' }); return; }

    const response = await anthropic.messages.create({
      model: MODELS.actions,
      max_tokens: 100,
      system: ACTION_CHECK_PROMPT,
      messages: [{ role: 'user', content: `User message: "${message}"\n\nWallet context: ${JSON.stringify(walletContext)}\n\nShould we execute an action?` }],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      try {
        const data = JSON.parse(content.text);
        res.json({ action: data.action || 'none', confidence: data.confidence || 0 });
      } catch { res.json({ action: 'none', confidence: 0 }); }
    } else { res.json({ action: 'none', confidence: 0 }); }
  } catch (error: any) {
    console.error('Error action check:', error);
    res.json({ action: 'none', confidence: 0 });
  }
});

const server = app.listen(Number(port), '0.0.0.0', () => {
  console.log(`🚀 Lucy AI Backend running on port ${port}`);
  console.log(`📡 Health: http://localhost:${port}/health`);
});

// Graceful shutdown for Railway
const shutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

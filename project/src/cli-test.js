import readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { handleIncomingMessage, testConnection } from './core/chatEngine.js';
import { config } from './config.js';
import { logger } from './services/logger.js';
import { closeDb, clearHistory } from './core/history.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

const TEST_CHANNEL = 'cli';
const TEST_USER_ID = 'test-user-cli';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Messenger Chatbot - CLI Test Mode                    ║');
  console.log('║     Gõ "exit" hoặc "quit" để thoát                        ║');
  console.log('║     Gõ "clear" để xóa lịch sử hội thoại                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  console.log(`Model: ${config.lmStudioChatModel}`);
  console.log(`LM Studio: ${config.lmStudioBaseUrl}`);
  console.log(`RAG: ${config.lmStudioEmbeddingModel || 'TẮT (chưa cấu hình LMSTUDIO_EMBEDDING_MODEL)'}`);
  console.log('');
  
  // Test connection
  console.log('🔄 Kiểm tra kết nối LM Studio...');
  const conn = await testConnection();
  if (!conn.success) {
    console.log(`❌ Kết nối thất bại: ${conn.error}`);
    console.log('Hãy chắc chắn LM Studio đang chạy (port 1234) và model đã được load.');
    process.exit(1);
  }
  console.log(`✅ Đã kết nối với model: ${conn.model}\n`);
  
  while (true) {
    try {
      const input = await rl.question('👤 Bạn: ');
      const text = input.trim();
      
      if (!text) continue;
      
      if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
        console.log('\n👋 Tạm biệt!');
        break;
      }
      
      if (text.toLowerCase() === 'clear') {
        clearHistory(TEST_CHANNEL, TEST_USER_ID);
        console.log('🧹 Đã xóa lịch sử hội thoại.');
        continue;
      }
      
      console.log('🤖 Bot: ', { end: '' });
      
      const response = await handleIncomingMessage({
        channel: TEST_CHANNEL,
        userId: TEST_USER_ID,
        text,
        eventId: `cli-${Date.now()}`,
        metadata: { source: 'cli' }
      });
      
      console.log(response);
      console.log(''); // empty line
      
    } catch (error) {
      if (error.name === 'AbortError' || error.message.includes('SIGINT')) {
        console.log('\n👋 Tạm biệt!');
        break;
      }
      logger.error('CLI error', { error: error.message });
      console.log('\n❌ Lỗi:', error.message);
    }
  }
  
  closeDb();
  rl.close();
  process.exit(0);
}

main().catch(err => {
  logger.error('CLI fatal error', { error: err.message, stack: err.stack });
  console.error('Fatal error:', err);
  process.exit(1);
});
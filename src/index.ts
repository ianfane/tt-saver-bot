import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import dotenv from 'dotenv';
import ffmpegPath from 'ffmpeg-static';

dotenv.config();

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const BOT_TOKEN = process.env.BOT_TOKEN || '';

if (!BOT_TOKEN) {
  console.error('Настройте BOT_TOKEN в .env файле');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

const tempDir = path.join(__dirname, '../temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

interface DownloadResult {
  type: 'video' | 'images';
  videoPath?: string;
  audioPath?: string;
  imagePaths?: string[];
}

async function extractAudio(videoPath: string): Promise<string> {
  const audioPath = videoPath.replace(/\.[^/.]+$/, '.mp3');
  
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .toFormat('mp3')
      .audioBitrate(128)
      .on('end', () => resolve(audioPath))
      .on('error', (err: Error) => reject(err))
      .save(audioPath);
  });
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function downloadTikTok(url: string): Promise<DownloadResult> {
  const apiUrl = 'https://www.tikwm.com/api/';
  
  const response = await axios.post(apiUrl, {
    url: url,
    hd: 1
  }, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response.data || response.data.code !== 0 || !response.data.data) {
    throw new Error('Не удалось скачать видео');
  }

  const data = response.data.data;

  if (data.images && data.images.length > 0) {
    const imagePaths: string[] = [];
    const videoId = crypto.randomBytes(8).toString('hex');

    for (let i = 0; i < data.images.length; i++) {
      const imageUrl = data.images[i];
      const imagePath = path.join(tempDir, `tiktok_${videoId}_${i}.jpg`);
      await downloadFile(imageUrl, imagePath);
      imagePaths.push(imagePath);
    }

    return { type: 'images', imagePaths };
  }

  const videoUrl = data.hdplay || data.play;
  const videoId = crypto.randomBytes(8).toString('hex');
  const videoPath = path.join(tempDir, `tiktok_${videoId}.mp4`);

  await downloadFile(videoUrl, videoPath);
  const audioPath = await extractAudio(videoPath);

  return { type: 'video', videoPath, audioPath };
}

function detectPlatform(url: string): 'tiktok' | null {
  if (url.includes('tiktok.com') || url.includes('vt.tiktok.com')) {
    return 'tiktok';
  }
  return null;
}

async function processVideo(ctx: Context, url: string) {
  const platform = detectPlatform(url);
  
  if (!platform) {
    await ctx.reply('Неподдерживаемая ссылка. Отправьте ссылку на TikTok.');
    return;
  }

  const statusMsg = await ctx.reply('⏳ Скачиваю...');

  try {
    const result = await downloadTikTok(url);

    if (result.type === 'images' && result.imagePaths) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '📸 Отправляю фото...'
      );

      const mediaGroup = result.imagePaths.slice(0, 10).map((imagePath) => ({
        type: 'photo' as const,
        media: { source: imagePath }
      }));

      await ctx.replyWithMediaGroup(mediaGroup);
      await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id);

      for (const imagePath of result.imagePaths) {
        fs.unlinkSync(imagePath);
      }
    } else if (result.type === 'video' && result.videoPath && result.audioPath) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '📹 Отправляю видео...'
      );

      await ctx.replyWithVideo({ source: result.videoPath });

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '🎵 Отправляю аудио...'
      );

      await ctx.replyWithAudio({ source: result.audioPath });
      await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id);

      fs.unlinkSync(result.videoPath);
      fs.unlinkSync(result.audioPath);
    }
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      `❌ Ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
}

bot.start((ctx) => {
  ctx.reply(
    '👋 Привет! Отправь мне ссылку на видео из TikTok'
  );
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex);

  if (urls && urls.length > 0) {
    for (const url of urls) {
      await processVideo(ctx, url);
    }
  } else {
    ctx.reply('Пожалуйста, отправьте ссылку на TikTok.');
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
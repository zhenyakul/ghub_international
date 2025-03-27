import { Bot, InlineKeyboard, Context } from "grammy";
import { UserData } from "./types";
import {
  handleStart,
  handleLanguageSelection,
  handleCarRequest,
  handleServiceToggle,
  handleServiceConfirmation,
  handlePaymentSelection,
  handleBackToCarRequest,
  handleBackToServices,
  handleTextMessage,
} from "./handlers";
import * as dotenv from "dotenv";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN || "");

// Set bot description
bot.api.setMyDescription(`👋 Welcome to G-Hub International!
Press /start to begin your journey with us.`);

// Store user data with timestamps for cleanup
interface UserDataWithTimestamp extends UserData {
  lastActivity: number;
  lastMessageTimestamp: number;
  messageCount: number;
}

const userDataMap = new Map<number, UserDataWithTimestamp>();
const USER_DATA_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const USER_DATA_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_MESSAGES_PER_WINDOW = 30; // Maximum messages per minute

// Rate limiting function
function isRateLimited(userData: UserDataWithTimestamp): boolean {
  const now = Date.now();
  if (now - userData.lastMessageTimestamp > RATE_LIMIT_WINDOW) {
    userData.messageCount = 0;
    userData.lastMessageTimestamp = now;
    return false;
  }
  return userData.messageCount >= MAX_MESSAGES_PER_WINDOW;
}

// Initialize user data with improved validation
function initializeUserData(userId: number): UserDataWithTimestamp {
  if (!userDataMap.has(userId)) {
    const now = Date.now();
    userDataMap.set(userId, {
      car_request: "",
      selected_services: new Set(),
      last_selector_message_id: null,
      payment_method: null,
      language: null,
      manager: null,
      messagesToDelete: [],
      keyboard_active: false,
      workflow_completed: false,
      lastActivity: now,
      lastMessageTimestamp: now,
      messageCount: 0,
    });
  } else {
    const userData = userDataMap.get(userId)!;
    userData.lastActivity = Date.now();
    userData.messageCount++;
  }
  return userDataMap.get(userId)!;
}

// Function to delete messages with improved error handling and rate limiting
async function deleteMessages(
  ctx: Context,
  messageIds: number[],
  maxRetries = 3,
  batchSize = 5
) {
  // Process messages in batches to avoid rate limits
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (messageId) => {
        let retries = 0;
        while (retries < maxRetries) {
          try {
            await ctx.api.deleteMessage(ctx.chat!.id, messageId);
            break;
          } catch (error) {
            retries++;
            if (retries === maxRetries) {
              console.error(
                `Failed to delete message ${messageId} after ${maxRetries} attempts:`,
                error
              );
            } else {
              // Exponential backoff with jitter
              const backoff = Math.min(1000 * Math.pow(2, retries), 10000);
              const jitter = Math.random() * 1000;
              await new Promise((resolve) =>
                setTimeout(resolve, backoff + jitter)
              );
            }
          }
        }
      })
    );
    // Add delay between batches to respect rate limits
    if (i + batchSize < messageIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Cleanup inactive user data with improved logging
function cleanupInactiveUserData() {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [userId, userData] of userDataMap.entries()) {
    if (now - userData.lastActivity > USER_DATA_EXPIRY) {
      userDataMap.delete(userId);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} inactive user sessions`);
  }
}

// Set up periodic cleanup with error handling
setInterval(() => {
  try {
    cleanupInactiveUserData();
  } catch (error) {
    console.error("Error during user data cleanup:", error);
  }
}, USER_DATA_CLEANUP_INTERVAL);

// Helper function to handle callback queries with improved error handling and rate limiting
async function handleCallbackQuery(
  ctx: Context,
  handler: (ctx: Context, userData: UserData, ...args: any[]) => Promise<void>,
  ...args: any[]
) {
  try {
    const userData = initializeUserData(ctx.from!.id);

    // Check rate limiting
    if (isRateLimited(userData)) {
      await ctx.reply("Please wait a moment before sending more messages.");
      return;
    }

    // Delete previous bot messages before handling new user input, except for warnings
    if (!userData.keyboard_active) {
      await deleteMessages(ctx, userData.messagesToDelete);
      userData.messagesToDelete = [];
    }

    // Handle the callback
    await handler(ctx, userData, ...args);
  } catch (error) {
    console.error("Error in callback query handler:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
    await ctx.reply("An error occurred. Please try again later.");
  }
}

// Command handlers with rate limiting
bot.command("start", async (ctx) => {
  try {
    const userData = initializeUserData(ctx.from!.id);
    if (isRateLimited(userData)) {
      await ctx.reply("Please wait a moment before sending more messages.");
      return;
    }
    await handleStart(ctx, userData);
  } catch (error) {
    console.error("Error in start command:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
    await ctx.reply("An error occurred. Please try again later.");
  }
});

// Callback query handlers with improved error handling and rate limiting
bot.callbackQuery(/^lang_(.+)$/, async (ctx) => {
  await handleCallbackQuery(ctx, handleLanguageSelection, ctx.match[1]);
});

bot.callbackQuery("back_to_car_request", async (ctx) => {
  await handleCallbackQuery(ctx, handleBackToCarRequest);
});

bot.callbackQuery("back_to_services", async (ctx) => {
  await handleCallbackQuery(ctx, handleBackToServices);
});

bot.callbackQuery(/^toggle_(.+)$/, async (ctx) => {
  await handleCallbackQuery(ctx, handleServiceToggle, ctx.match[1]);
});

bot.callbackQuery("confirm_services", async (ctx) => {
  await handleCallbackQuery(ctx, handleServiceConfirmation);
});

bot.callbackQuery(/^payment_(.+)$/, async (ctx) => {
  await handleCallbackQuery(ctx, handlePaymentSelection, ctx.match[1]);
});

// Message handler for car request with improved error handling and rate limiting
bot.on("message:text", async (ctx) => {
  try {
    const userData = initializeUserData(ctx.from!.id);

    // Check rate limiting
    if (isRateLimited(userData)) {
      await ctx.reply("Please wait a moment before sending more messages.");
      return;
    }

    // Delete previous bot messages before handling new user input, except for warnings
    if (!userData.keyboard_active) {
      await deleteMessages(ctx, userData.messagesToDelete);
      userData.messagesToDelete = [];
    }

    if (userData.keyboard_active) {
      await handleTextMessage(ctx, userData);
      return;
    }

    if (!userData.language) {
      return;
    }

    await handleCarRequest(ctx, userData, ctx.message.text);
  } catch (error) {
    console.error("Error in message handler:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
    await ctx.reply("An error occurred. Please try again later.");
  }
});

// Error handling middleware with improved logging
bot.catch((err) => {
  console.error("Error in bot:", err);
  if (err.error instanceof Error) {
    console.error("Error details:", {
      name: err.error.name,
      message: err.error.message,
      stack: err.error.stack,
    });
  }
});

// Start the bot with error handling
bot.start().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});

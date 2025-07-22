const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const express = require('express'); // Import express

// --- Configuration from Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Vercel provides the PORT environment variable
const PORT = process.env.PORT || 3000;
// You'll get this URL from Vercel after your first deployment.
// It will look something like https://your-project-name.vercel.app
const VERCEL_URL = process.env.VERCEL_URL; // Vercel automatically sets this

// --- Initialize Bot, Supabase Client, and Express App ---
// IMPORTANT: Remove { polling: true }
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express(); // Initialize Express app
app.use(express.json()); // Middleware to parse JSON request bodies

console.log('Bot starting...');

// --- Webhook Endpoint ---
// This is the URL path Telegram will send updates to
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`; // Use token for unique path
const WEBHOOK_URL = `${VERCEL_URL}${WEBHOOK_PATH}`;

// Set the webhook with Telegram
// This function needs to run only once after deployment or if the URL changes
async function setWebhook() {
    try {
        await bot.setWebHook(WEBHOOK_URL);
        console.log(`Webhook set to: ${WEBHOOK_URL}`);
    } catch (error) {
        console.error('Error setting webhook:', error.message);
        // Exit process or handle error if webhook can't be set
        // For Vercel, this is usually handled correctly during deployment startup
    }
}

// Listen for incoming updates from Telegram
app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body); // Process the update
    res.sendStatus(200); // Respond quickly to Telegram
});

// Basic endpoint to confirm the server is running (optional)
app.get('/', (req, res) => {
    res.send('Telegram bot is running.');
});

// Start the Express server
app.listen(PORT, async () => {
    console.log(`Express server listening on port ${PORT}`);
    if (VERCEL_URL) { // Only set webhook if Vercel URL is available (i.e., not local dev)
        await setWebhook();
    } else {
        console.warn('VERCEL_URL not found, webhook will not be set. Running in local development mode.');
    }
});


// --- Helper function for currency display (UNCHANGED) ---
function formatCurrency(amount, currency) {
    const safeCurrency = (currency && typeof currency === 'string' && currency.trim() !== '') ? currency.toLowerCase() : 'unknown';
    const symbol = safeCurrency === 'tara' ? '🟢' : '🗿🟢';
    const displayCurrency = (currency && typeof currency === 'string' && currency.trim() !== '') ? currency.toUpperCase() : 'UNKNOWN';
    return `${amount} ${displayCurrency} ${symbol}`;
}

// --- Bot Commands (UNCHANGED from previous version, copy all the handlers) ---

// /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type === 'private') {
        bot.sendMessage(chatId, 'Hello! I am your admin-tip bot. Send me /claimtip if you have a pending tip, or /help to see what else I can do.');
    } else {
        bot.sendMessage(chatId, 'Hello! I am your admin-tip bot. Admins can use /tip here. Other users can DM me directly for /claimtip.');
    }
});

// /help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `
I am a specialized bot for admin-only CHDPU/TARA tipping.

Commands:
/tip @username <amount> <chdpu|tara> - (Admin Only) Initiate a tip to a user in a group.
/claimtip - (User in DM) Claim a pending tip.
/done <tip_id> <tx_hash> - (Admin Only, in DM) Mark a tip as fulfilled and notify the group.
    `;
    bot.sendMessage(chatId, helpText);
});

// /tip command (Admin Only) - Make sure to include group_chat_id in insert!
bot.onText(/\/tip\s+@(\w+)\s+(\d+(\.\d+)?)\s+(chdpu|tara)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    // 1. Admin verification
    if (adminId !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, 'Sorry, only the admin can use the /tip command.');
        return;
    }

    const recipientUsername = match[1];
    const amount = parseFloat(match[2]);
    const currency = match[4].toLowerCase();

    if (isNaN(amount) || amount <= 0) {
        bot.sendMessage(chatId, 'Please specify a valid positive amount to tip.');
        return;
    }
    if (!['chdpu', 'tara'].includes(currency)) {
        bot.sendMessage(chatId, 'Invalid currency. Please specify "chdpu" or "tara".');
        return;
    }

    const actualRecipientUsername = recipientUsername.startsWith('@') ? recipientUsername : `@${recipientUsername}`;

    // 2. Store pending tip in Supabase
    let newTip;
    try {
        let recipientTgId = null;
        if (msg.entities) {
            for (const entity of msg.entities) {
                if (entity.type === 'mention' && entity.user) {
                    const mentionedUsername = msg.text.substring(entity.offset + 1, entity.offset + entity.length);
                    if (mentionedUsername.toLowerCase() === recipientUsername.toLowerCase()) {
                        recipientTgId = entity.user.id;
                        break;
                    }
                }
            }
        }
        
        const { data, error } = await supabase
            .from('tips')
            .insert([
                { 
                    admin_tg_id: adminId,
                    recipient_username: actualRecipientUsername.toLowerCase(),
                    recipient_tg_id: recipientTgId,
                    amount: amount,
                    currency: currency,
                    status: 'awaiting_claim',
                    group_chat_id: chatId // <--- ADDED THIS LINE FOR GROUP NOTIFICATION
                }
            ])
            .select();

        if (error) throw error;
        if (!data || data.length === 0) throw new Error('No data returned after insert.');

        newTip = data[0];
        console.log('New tip created:', newTip);

    } catch (error) {
        console.error('Error storing tip in Supabase:', error.message);
        bot.sendMessage(chatId, 'Failed to save tip data to database. Please try again.');
        return;
    }

    // 3. Announce in the group that the user needs to DM the bot
    try {
        await bot.sendMessage(
            chatId,
            `${actualRecipientUsername} - You've been tipped ${formatCurrency(amount, currency)}! 🎉 Please DM me (click my name and send /claimtip) to claim your tip.\n\nThank you for contributing to (TCCP) Taraxa Chad Culture Production!`
        );
        console.log(`Tip request for ${actualRecipientUsername} (${amount} ${currency.toUpperCase()}) initiated. Group notified.`);
    } catch (error) {
        console.error(`Error announcing tip in chat ${chatId}:`, error.message);
        bot.sendMessage(chatId, `Failed to announce tip for ${actualRecipientUsername} in this chat.`);
    }
});

// /claimtip Command Handler (User DM Side)
bot.onText(/\/claimtip/i, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username ? `@${msg.from.username.toLowerCase()}` : null;
    const chatId = msg.chat.id;

    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, 'Please use the /claimtip command in a private chat with me, not in a group.');
        return;
    }

    let pendingTips;
    try {
        const { data, error } = await supabase
            .from('tips')
            .select('*')
            .or(`recipient_tg_id.eq.${userId},recipient_username.eq.${username}`)
            .eq('status', 'awaiting_claim');

        if (error) throw error;
        pendingTips = data;

        if (!pendingTips || pendingTips.length === 0) {
            const userNameDisplay = msg.from.first_name || 'there';
            bot.sendMessage(chatId, `Sorry ${userNameDisplay} - you've got no tips to claim yet. Be an engaged community member in future to get admin tips!`);
            return;
        }

    } catch (error) {
        console.error('Error fetching pending tips:', error.message);
        bot.sendMessage(chatId, 'An error occurred while looking for your tips. Please try again later.');
        return;
    }

    const tipToClaim = pendingTips[0]; // Assuming one pending tip for simplicity for now

    try {
        const { error: updateError } = await supabase
            .from('tips')
            .update({
                recipient_tg_id: userId, // Ensure TG ID is captured even if by username initially
                status: 'awaiting_recipient_address'
            })
            .eq('id', tipToClaim.id);

        if (updateError) throw updateError;
        console.log(`Tip ${tipToClaim.id} updated to awaiting_recipient_address for user ${userId}`);

    } catch (error) {
        console.error(`Error updating tip ${tipToClaim.id} status:`, error.message);
        bot.sendMessage(chatId, 'An error occurred while preparing your tip. Please try again.');
        return;
    }

    try {
        const { error: stateError } = await supabase
            .from('user_states')
            .upsert(
                {
                    user_id: userId,
                    state: 'awaiting_address_for_tip',
                    context_id: tipToClaim.id
                },
                { onConflict: 'user_id' }
            );

        if (stateError) throw stateError;
        console.log(`User state set for ${userId} to awaiting_address_for_tip for tip ${tipToClaim.id}`);

        // Ask for the address, including currency
        await bot.sendMessage(
            chatId,
            `Okay, you're claiming ${formatCurrency(tipToClaim.amount, tipToClaim.currency)}. Please reply to this message with a valid Taraxa EVM address (starting with \`0x...\`) to receive your tip.`
        );

    } catch (error) {
        console.error(`Error setting user state or sending address prompt for ${userId}:`, error.message);
        bot.sendMessage(chatId, 'Something went wrong. Please try /claimtip again.');
    }
});

// Handle General Messages (for collecting addresses AND Admin Notification)
bot.on('message', async (msg) => {
    // Ignore commands and messages not from private chats
    if (msg.chat.type === 'private' && !msg.text.startsWith('/')) {
        const userId = msg.from.id;
        try {
            const { data: userState, error } = await supabase
                .from('user_states')
                .select('*')
                .eq('user_id', userId)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 means "no rows found", which is expected if no state
                throw error;
            }

            if (userState && userState.state === 'awaiting_address_for_tip') {
                const potentialAddress = msg.text.trim();
                // Basic address validation
                if (/^0x[a-fA-F0-9]{40}$/.test(potentialAddress)) {
                    // Fetch the tip details to get amount and currency (re-fetch for safety/completeness)
                    const { data: tipDetails, error: fetchTipError } = await supabase
                        .from('tips')
                        .select('id, recipient_username, recipient_tg_id, amount, currency, admin_tg_id')
                        .eq('id', userState.context_id)
                        .single();
                    
                    if (fetchTipError) throw fetchTipError;
                    if (!tipDetails) throw new Error('Tip details not found for context_id');

                    // Update the tip with the address and new status
                    const { error: tipUpdateError } = await supabase
                        .from('tips')
                        .update({ 
                            recipient_address: potentialAddress,
                            status: 'ready_for_admin_fulfillment' // This is the status that triggers your manual fulfillment
                        })
                        .eq('id', userState.context_id);

                    if (tipUpdateError) throw tipUpdateError;
                    
                    // Clear the user's state
                    const { error: stateClearError } = await supabase
                        .from('user_states')
                        .delete()
                        .eq('user_id', userId);

                    if (stateClearError) throw stateClearError;
                    
                    console.log(`Address received from ${userId}: ${potentialAddress}`);
                    await bot.sendMessage(msg.chat.id, 'Thank you! Your address has been saved. The admin will fulfill your tip shortly.');
                    
                    // --- ADMIN NOTIFICATION ---
                    const adminNotificationMessage = `
                        💰 **NEW TIP READY FOR MANUAL FULFILLMENT!** 💰

                        Tip ID: \`${tipDetails.id}\`
                        Recipient: ${tipDetails.recipient_username || msg.from.username ? `@${msg.from.username}` : userId} (TG ID: ${tipDetails.recipient_tg_id || userId})
                        Amount: ${formatCurrency(tipDetails.amount, tipDetails.currency)}
                        **Address: \`${potentialAddress}\`**

                        Please manually send this tip. Reply to this message with \`/done ${tipDetails.id} <transaction_hash>\` after sending.
                    `;
                    await bot.sendMessage(ADMIN_TELEGRAM_ID, adminNotificationMessage, { parse_mode: 'Markdown' });
                    console.log(`Admin notified for tip ${tipDetails.id} with all details.`);

                } else {
                    await bot.sendMessage(msg.chat.id, 'That doesn\'t look like a valid Taraxa EVM address. Please try again. It should start with `0x` and be 42 characters long.');
                }
            }
        } catch (err) {
            console.error('Error handling message for user state:', err.message);
            bot.sendMessage(msg.chat.id, 'An unexpected error occurred. Please try again.');
        }
    }
});

// --- New: /done Command (Admin Only, for confirming fulfillment) ---
bot.onText(/\/done\s+([0-9a-fA-F-]+)\s*(0x[a-fA-F0-9]{64})?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    if (adminId !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, 'Sorry, only the admin can use the /done command.');
        return;
    }

    const tipId = match[1];
    const txHash = match[2] || null; // Optional transaction hash

    try {
        // Fetch tip details to get recipient and currency for group notification
        const { data: tip, error: fetchError } = await supabase
            .from('tips')
            .select('recipient_username, recipient_tg_id, amount, currency, admin_tg_id, group_chat_id') // <--- Make sure group_chat_id is selected
            .eq('id', tipId)
            .single();

        if (fetchError) throw fetchError;
        if (!tip) {
            bot.sendMessage(chatId, `Tip with ID \`${tipId}\` not found.`);
            return;
        }

        // Update tip status to 'fulfilled'
        const { error: updateError } = await supabase
            .from('tips')
            .update({ status: 'fulfilled', tx_hash: txHash })
            .eq('id', tipId);

        if (updateError) throw updateError;

        bot.sendMessage(chatId, `Tip \`${tipId}\` marked as fulfilled.`);
        console.log(`Tip ${tipId} marked as fulfilled by admin. Tx Hash: ${txHash || 'N/A'}`);

        // Notify the recipient/group that the tip has been fulfilled
        let recipientDisplay = tip.recipient_username || `user with ID ${tip.recipient_tg_id}`;
        let fulfillmentMessage = `
            🎉 Your tip for ${formatCurrency(tip.amount, tip.currency)} has been fulfilled! 🎉
            Recipient: ${recipientDisplay}
        `;
        if (txHash) {
            fulfillmentMessage += `\nTransaction: \`${txHash}\``;
        }

        // Try to notify the user directly if tg_id is available
        if (tip.recipient_tg_id) {
            try {
                await bot.sendMessage(tip.recipient_tg_id, fulfillmentMessage, { parse_mode: 'Markdown' });
                console.log(`Notified recipient ${recipientDisplay} directly about fulfillment.`);
            } catch (dmError) {
                console.warn(`Could not DM recipient ${recipientDisplay} (${tip.recipient_tg_id}) about fulfillment. Error: ${dmError.message}.`);
                // If DM fails, try group if possible
                if (tip.group_chat_id) {
                    try {
                        await bot.sendMessage(tip.group_chat_id, fulfillmentMessage, { parse_mode: 'Markdown' });
                        console.log(`Notified group ${tip.group_chat_id} about fulfillment after DM failure.`);
                    } catch (groupError) {
                        console.error(`Failed to notify original group ${tip.group_chat_id}:`, groupError.message);
                    }
                } else {
                     console.warn(`No group chat ID to fallback for tip ${tipId}.`);
                }
            }
        } else if (tip.group_chat_id) { // If recipient_tg_id was not captured, but group_chat_id is
            try {
                await bot.sendMessage(tip.group_chat_id, fulfillmentMessage, { parse_mode: 'Markdown' });
                console.log(`Notified original group ${tip.group_chat_id} about fulfillment.`);
            } catch (groupError) {
                console.error(`Failed to notify original group ${tip.group_chat_id}:`, groupError.message);
            }
        } else {
            console.warn(`No recipient TG ID or group chat ID for tip ${tipId}. Cannot notify about fulfillment.`);
        }

    } catch (error) {
        console.error('Error handling /done command:', error.message);
        bot.sendMessage(chatId, `Failed to mark tip as fulfilled: ${error.message}`);
    }
});


// Log any errors from the polling process
// This particular error handler might become less relevant for webhook setup
// as errors would be more about HTTP request handling rather than polling failures.
bot.on('polling_error', (err) => console.error('Polling Error (should not occur with webhooks):', err.message));

console.log('Bot is running and listening for commands...');
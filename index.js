const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// --- Configuration from Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Define the specific CHDPU burn address (now purely for user information)
const CHDPU_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// --- Initialize Bot and Supabase Client ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

console.log('Bot starting in polling mode...');

// --- Helper function for currency display ---
function formatCurrency(amount, currency) {
    const safeCurrency = (currency && typeof currency === 'string' && currency.trim() !== '') ? currency.toLowerCase() : 'unknown';
    const symbol = safeCurrency === 'tara' ? '🟢' : '🗿🟢';
    const displayCurrency = (currency && typeof currency === 'string' && currency.trim() !== '') ? currency.toUpperCase() : 'UNKNOWN';
    return `${amount} ${displayCurrency} ${symbol}`;
}

// --- Bot Commands ---

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
/done <tip_id> <tx_hash> - (Admin Only, in DM) Mark a tip as fulfilled and notify the recipient.
    `;
    bot.sendMessage(chatId, helpText);
});

// /tip command (Admin Only)
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
                    status: 'awaiting_claim'
                    // is_burned flag removed
                }
            ])
            .select();

        if (error) throw error;
        if (!data || data.length === 0) throw new Error('No data returned after insert.');

        const newTip = data[0];
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
            `${actualRecipientUsername} - 💰You've been tipped ${formatCurrency(amount, currency)}! Please DM @chdputip_bot and send "/claimtip" to claim your tip.\n\nThank you for contributing to (TCCP) Taraxa Chad Culture Production`
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
        bot.sendMessage(chatId, 'no no, almost, please use the /claimtip command in a private chat with me, not in a group.');
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
            bot.sendMessage(chatId, `Sorry ${userNameDisplay} - you've got no tips to claim yet. Be an engaged community member in future to get tips! Participate in social media raids, make memes, be active in the TG, make your own unique $chdpu posts on X. All of these could lead to more than just the tip ;) nfa`);
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

        let replyMessage = `Hey chad, you're claiming ${formatCurrency(tipToClaim.amount, tipToClaim.currency)}. `;
        
        // Always include the burn address option, regardless of currency
        replyMessage += `Please reply to this message with a valid Taraxa EVM address (starting with \`0x...\`) to receive your tip.\n\n` +
                        `*🔥If you'd like to send it to the burn address, copy and send this:*\n\`${CHDPU_BURN_ADDRESS}\`\n\n` +
                        `PU TO THE MOON 🗿🟢`; 

        await bot.sendMessage(
            chatId,
            replyMessage,
            { parse_mode: 'Markdown' }
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
                
                // Fetch tip details
                const { data: tipDetails, error: fetchTipError } = await supabase
                    .from('tips')
                    .select('id, recipient_username, recipient_tg_id, amount, currency, admin_tg_id') // is_burned removed
                    .eq('id', userState.context_id)
                    .single();
                
                if (fetchTipError) throw fetchTipError;
                if (!tipDetails) throw new Error('Tip details not found for context_id');

                // Validate as a general EVM address
                if (/^0x[a-fA-F0-9]{40}$/.test(potentialAddress)) {
                    // Update the tip with the address and new status
                    const { error: tipUpdateError } = await supabase
                        .from('tips')
                        .update({ 
                            recipient_address: potentialAddress,
                            status: 'ready_for_admin_fulfillment'
                            // is_burned flag update removed
                        })
                        .eq('id', userState.context_id);

                    if (tipUpdateError) throw tipUpdateError;
                    
                    // Clear the user's state
                    const { error: stateClearError } = await supabase
                        .from('user_states')
                        .delete()
                        .eq('user_id', userId);

                    if (stateClearError) throw stateClearError;
                    
                    console.log(`Address received from ${userId}: ${potentialAddress}.`);
                    await bot.sendMessage(msg.chat.id, 'Thank you! Your address has been received. The Chadmin will fulfill your request shortly. Keep up the good work - $chdpu to $1, $tara $10');
                    
                    // --- ADMIN NOTIFICATION (generic, no burn distinction) ---
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
                    // Invalid address format
                    await bot.sendMessage(msg.chat.id, 'That doesn\'t look like a valid Taraxa EVM address. Please try again. It should start with `0x` and be 42 characters long.');
                }
            }
        } catch (err) {
            console.error('Error handling message for user state:', err.message);
            bot.sendMessage(msg.chat.id, 'An unexpected error occurred. Please try again.');
        }
    }
});

// --- /done Command (Admin Only, for confirming fulfillment) ---
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
        // Fetch tip details
        const { data: tip, error: fetchError } = await supabase
            .from('tips')
            .select('recipient_username, recipient_tg_id, amount, currency, recipient_address') // is_burned removed
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

        // Notify the recipient (generic fulfillment message)
        let recipientDisplay = tip.recipient_username || `user with ID ${tip.recipient_tg_id}`;
        let fulfillmentMessage = `
            🎉 Your tip for ${formatCurrency(tip.amount, tip.currency)} has been sent! 🎉
            Recipient: ${recipientDisplay}
        `;
        // Optionally, check if the recipient_address for this tip was the burn address,
        // and add a note. This is a *visual* distinction, not based on a 'burn' flag.
        if (tip.recipient_address && tip.recipient_address.toLowerCase() === CHDPU_BURN_ADDRESS.toLowerCase()) {
             fulfillmentMessage += `\n(Note: This tip was sent to the burn address \`${CHDPU_BURN_ADDRESS}\` as per your request.)`;
        }

        if (txHash) {
            fulfillmentMessage += `\nTransaction: \`${txHash}\``;
        }
        
        // Try to notify the user directly if tg_id is available
        if (tip.recipient_tg_id) {
            try {
                await bot.sendMessage(tip.recipient_tg_id, fulfillmentMessage, { parse_mode: 'Markdown' });
                console.log(`Notified recipient ${recipientDisplay} directly about fulfillment.`);
            } catch (dmError) {
                console.warn(`Could not DM recipient ${recipientDisplay} (${tip.recipient_tg_id}) about fulfillment. Error: ${dmError.message}. Recipient may need to start a DM with the bot first.`);
                 bot.sendMessage(chatId, `Failed to DM recipient ${recipientDisplay}. They might need to start a DM with the bot first.`);
            }
        } else {
            console.warn(`No recipient TG ID for tip ${tipId}. Cannot notify recipient directly about fulfillment.`);
            bot.sendMessage(chatId, `Tip ${tipId} fulfilled, but cannot directly notify recipient as TG ID was not captured. They can check their wallet.`);
        }

    } catch (error) {
        console.error('Error handling /done command:', error.message);
        bot.sendMessage(chatId, `Failed to mark tip as fulfilled: ${error.message}`);
    }
});

// IMPORTANT: Add this polling_error handler back for polling mode
bot.on('polling_error', (err) => console.error('Polling Error:', err.message));

console.log('Bot is running and listening for commands...');
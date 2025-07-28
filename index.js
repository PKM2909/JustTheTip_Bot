const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// --- Configuration from Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Define the specific CHDPU burn address (now purely for user information)
const CHDPU_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// Define the GROUP CHAT ID for notifications (Provided by User)
// This is the fixed group where all FULFILLMENT notifications will be sent.
const GROUP_NOTIFICATION_CHAT_ID = -1002500146680; // Replace with your actual group chat ID

// --- Initialize Bot and Supabase Client ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

console.log('Bot starting in polling mode...');

// --- Helper function for currency display ---
function formatCurrency(amount, currency) {
    const safeCurrency = (currency && typeof currency === 'string' && currency.trim() !== '') ? currency.toLowerCase() : 'unknown';
    const symbol = safeCurrency === 'tara' ? '🟢' : '🗿🟢';
    const displayCurrency = (currency && typeof currency === 'string' && currency.trim() !== '') ? currency.toUpperCase() : 'UNKNOWN';
    return `${amount.toLocaleString()} ${displayCurrency} ${symbol}`; // Use toLocaleString for amount here too
}

// --- Helper function to escape MarkdownV2 special characters ---
// This is crucial when injecting user-generated or potentially problematic strings into Markdown.
function escapeMarkdown(text) {
    if (text === null || typeof text === 'undefined') {
        return '';
    }
    const str = String(text); // Ensure it's a string
    // Escape all characters that have special meaning in MarkdownV2
    return str.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// --- NEW Helper function for randomized CHDPU group fulfillment messages ---
function formatChdpuForGroupNotification(amountChdpu, username, isBurn) {
    const CHDPU_TO_STEVEN_RATIO = 100;
    const CHDPU_TO_PU_RATIO = 1_000_000; // 1 CHDPU = 1,000,000 Pu

    const escapedUsername = escapeMarkdown(username.replace('@', ''));

    if (isBurn) {
        return `@${escapedUsername} burned their tip ✅🔥`;
    }

    const options = [
        { unit: 'CHDPU', ratio: 1, symbol: '' }, // Removed 🗿🟢
        { unit: 'Steven', ratio: CHDPU_TO_STEVEN_RATIO, symbol: '', explainer: '1 Steven = 0.01 CHDPU' }, // Removed 🗿🟢
        { unit: 'Pu', ratio: CHDPU_TO_PU_RATIO, symbol: '', explainer: '1 Pu = 0.000001 CHDPU' } // Removed 🗿🟢
    ];

    // Randomly select one of the options
    const selectedOption = options[Math.floor(Math.random() * options.length)];

    const convertedAmount = Math.floor(amountChdpu * selectedOption.ratio); // Use Math.floor for integer units
    const formattedAmount = convertedAmount.toLocaleString();

    // Changed to include ✅ explicitly, removed selectedOption.symbol
    let message = `@${escapedUsername} has been tipped ${formattedAmount} ${selectedOption.unit} ✅`;

    if (selectedOption.explainer) {
        // Add explainer two lines below in italics
        message += `\n\n_(${escapeMarkdown(selectedOption.explainer)})_`;
    }

    return message;
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
/tip (as a reply to a message) - (Admin Only) Tips the replied user 1000 CHDPU.
/pendingclaims - (DM Only) See how many tips you have waiting to claim.
/claimall - (DM Only) Claim all your pending tips at once.
/claimtip - (DM Only) Claim a single pending tip.
/done <tip_id> <tx_hash> - (Admin Only, in DM) Mark an individual tip as fulfilled.
/donebatch <batch_id> <tx_hash> - (Admin Only, in DM) Mark a batch claim as fulfilled.
/stats - (Admin Only, in DM) See total tips sent.
/pudemon - See CHDPU denominations (sends an image).
/outstandingtips - (Admin Only, in Group) See a list of users with unclaimed tips.
    `;
    bot.sendMessage(chatId, helpText);
});

// --- /pudemon command (Public Use) - sends an image ---
bot.onText(/\/pudemon/i, (msg) => {
    const chatId = msg.chat.id;
    const imageUrl = 'https://chadpu.carrd.co/assets/images/image31.jpg?v=2d81c3a5';

    bot.sendPhoto(chatId, imageUrl, { caption: '📏 $CHDPU Denominations' })
        .then(() => console.log(`Sent CHDPU denominations image to chat ${chatId}`))
        .catch(error => console.error(`Error sending photo to chat ${chatId}:`, error.message));
});

// --- /tip command (Admin Only) - handles @username <amount> <currency> ---
// This handler should come BEFORE the more general /tip handler
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
                }
            ])
            .select();
        if (error) throw error;
        if (!data || data.length === 0) throw new Error('No data returned after insert.');
        const newTip = data[0];
        console.log('New tip created:', newTip);

        // --- Removed redundant first message, keeping only the detailed one ---
        // await bot.sendMessage(
        //     chatId, // Use the current chatId where the command was issued
        //     `${actualRecipientUsername} has been tipped ${formatCurrency(amount, currency)}! DM the bot to claim it.`
        // );
        // console.log(`Group notified about new tip for ${actualRecipientUsername}.`);


    } catch (error) {
        console.error('Error storing tip in Supabase:', error.message);
        bot.sendMessage(chatId, 'Failed to save tip data to database. Please try again.');
        return;
    }

    // 3. Announce in the group that the user needs to DM the bot
    try {
        await bot.sendMessage(
            chatId,
            `${actualRecipientUsername} - 💰You've been tipped ${formatCurrency(amount, currency.toUpperCase())}!\n Please DM @chdputip_bot and send "/claimtip" to claim your tip.

Thank you for contributing to the TCCP
Taraxa Chad Culture Production
`
        );
        console.log(`Tip request for ${actualRecipientUsername} (${amount} ${currency.toUpperCase()}) initiated. Group notified.`);
    } catch (error) {
        console.error(`Error announcing tip in chat ${chatId}:`, error.message);
        bot.sendMessage(chatId, `Failed to announce tip for ${actualRecipientUsername} in this chat.`);
    }
});

// --- /tip command (Admin Only, as a reply OR general usage message) ---
// This handler should come AFTER the more specific /tip handler
bot.onText(/\/tip/i, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    // 1. Admin verification
    if (adminId !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, 'Sorry, only the admin can use the /tip command.');
        return;
    }

    // Check if it's a reply
    if (msg.reply_to_message) {
        // Extract recipient details from the replied message
        const recipientUser = msg.reply_to_message.from;
        const recipientTgId = recipientUser.id;
        const recipientUsername = recipientUser.username ? `@${recipientUser.username.toLowerCase()}` : null;
        const recipientNameDisplay = recipientUser.first_name ? escapeMarkdown(recipientUser.first_name) : (recipientUser.username ? `@${recipientUser.username}` : `User ID: ${escapeMarkdown(String(recipientTgId))}`);

        // Define the fixed tip amount and currency
        const amount = 1000; // Fixed amount
        const currency = 'chdpu'; // Fixed currency

        if (recipientTgId === adminId) {
            bot.sendMessage(chatId, `You cannot tip yourself, ${recipientNameDisplay}!`);
            return;
        }

        // 3. Store pending tip in Supabase (reusing existing logic structure)
        try {
            const { data, error } = await supabase
                .from('tips')
                .insert([
                    {
                        admin_tg_id: adminId,
                        recipient_username: recipientUsername,
                        recipient_tg_id: recipientTgId,
                        amount: amount,
                        currency: currency,
                        status: 'awaiting_claim'
                    }
                ])
                .select();

            if (error) throw error;
            if (!data || data.length === 0) throw new Error('No data returned after insert.');
            const newTip = data[0];
            console.log('New reply-based tip created:', newTip);

            // --- Removed redundant first message, keeping only the detailed one ---
            // await bot.sendMessage(
            //     chatId, // Use the current chatId where the command was issued
            //     `${recipientUsername || recipientNameDisplay} has been tipped ${formatCurrency(amount, currency)}! DM the bot to claim it.`
            // );
            // console.log(`Group notified about new reply-tip for ${recipientUsername || recipientNameDisplay}.`);


        } catch (error) {
            console.error('Error storing reply-based tip in Supabase:', error.message);
            bot.sendMessage(chatId, 'Failed to save reply-based tip data to database. Please try again.');
            return;
        }

        // 4. Announce in the group that the user needs to DM the bot
        try {
            await bot.sendMessage(
                chatId,
                `${recipientNameDisplay} - 💰You've been tipped ${formatCurrency(amount, currency.toUpperCase())}!\n Please DM @chdputip_bot and send "/claimtip" to claim your tip.

Thank you for contributing to the TCCP
Taraxa Chad Culture Production
`
            );
            console.log(`Reply-based tip request for ${recipientNameDisplay} (${amount} ${currency.toUpperCase()}) initiated. Group notified.`);
        } catch (error) {
            console.error(`Error announcing reply-based tip in chat ${chatId}:`, error.message);
            bot.sendMessage(chatId, `Failed to announce reply-based tip for ${recipientNameDisplay} in this chat.`);
        }
    } else {
        // If it's just "/tip" without a reply and didn't match the specific regex above
        // This is where we provide the usage instructions.
        bot.sendMessage(chatId, 'To use /tip, please either reply to a message or specify the recipient, amount, and currency, e.g., `/tip @username 1000 chdpu`', { parse_mode: 'Markdown' });
        return;
    }
});


// --- /outstandingtips command (Admin Only, in Group) ---
bot.onText(/\/outstandingtips/i, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    // 1. Admin verification
    if (adminId !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, 'Sorry, only the admin can use the /outstandingtips command.');
        return;
    }

    // Ensure it's used in a group chat
    if (msg.chat.type === 'private') {
        bot.sendMessage(chatId, 'Please use the /outstandingtips command in a group chat.');
        return;
    }

    try {
        const { data: pendingTips, error: tipError } = await supabase
            .from('tips')
            .select('recipient_username, amount, currency')
            .eq('status', 'awaiting_claim')
            .is('batch_claim_id', null); // Only count tips not already part of a batch

        if (tipError) throw tipError;

        if (!pendingTips || pendingTips.length === 0) {
            bot.sendMessage(chatId, 'There are currently no outstanding tips to claim. Everyone\'s claimed their Chadpu!');
            return;
        }

        let response = `The below users have unclaimed tips:\n\n`;
        pendingTips.forEach(tip => {
            response += `@${escapeMarkdown(tip.recipient_username.replace('@', ''))} - ${formatCurrency(tip.amount, tip.currency)}\n`;
        });

        response += `\nPlease DM the bot to claim or burn your tips.`;

        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error fetching outstanding tips:', error.message);
        bot.sendMessage(chatId, 'An error occurred while fetching outstanding tips. Please try again.');
    }
});


// --- /pendingclaims command (User in DM) ---
bot.onText(/\/pendingclaims/i, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username ? `@${msg.from.username.toLowerCase()}` : null;
    const chatId = msg.chat.id;

    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, 'no no, almost, please use the /pendingclaims command in a private chat with me.');
        return;
    }

    try {
        const { data: pendingTips, error: tipError } = await supabase
            .from('tips')
            .select('id, amount, currency, admin_tg_id')
            .or(`recipient_tg_id.eq.${userId},recipient_username.eq.${username}`)
            .eq('status', 'awaiting_claim')
            .is('batch_claim_id', null); // Only count tips not already part of a batch

        if (tipError) throw tipError;

        if (!pendingTips || pendingTips.length === 0) {
            const userNameDisplay = msg.from.first_name ? escapeMarkdown(msg.from.first_name) : 'there';
            bot.sendMessage(chatId, `Sorry ${userNameDisplay} - you've got no tips to claim YET.

Be an engaged community member in future to get tips!

Participate in X media raids, make memes, be active in the TG, make your own unique $chdpu posts on X. All of these could lead to more than just the tip ;)
https://x.com/ChadPuOfficial `);
            return;
        }

        const totalTipsCount = pendingTips.length;
        let totalAmountCHDPU = 0;
        let totalAmountTARA = 0;

        pendingTips.forEach(tip => {
            if (tip.currency.toLowerCase() === 'chdpu') {
                totalAmountCHDPU += tip.amount;
            }
            if (tip.currency.toLowerCase() === 'tara') {
                totalAmountTARA += tip.amount;
            }
        });
        let response = `You have *${totalTipsCount} pending tips*:\n`;
        if (totalAmountCHDPU > 0) {
            response += `- ${formatCurrency(totalAmountCHDPU, 'CHDPU')}\n`;
        }
        if (totalAmountTARA > 0) {
            response += `- ${formatCurrency(totalAmountTARA, 'TARA')}\n`;
        }

        if (totalTipsCount > 1) {
            response += `\nTo claim all of them at once, use the command: \`/claimall\``;
        } else {
            response += `\nTo claim this tip, use the command: \`/claimtip\``;
        }

        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error fetching pending claims:', error.message);
        bot.sendMessage(chatId, 'An error occurred while checking your pending tips. Please try again later.');
    }
});

// --- /claimall command (User in DM) ---
bot.onText(/\/claimall/i, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username ? `@${msg.from.username.toLowerCase()}` : null;
    const chatId = msg.chat.id;

    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, 'Please use the /claimall command in a private chat with me.');
        return;
    }

    try {
        // Fetch pending tips for this user that are not already part of a batch
        const { data: pendingTips, error: tipError } = await supabase
            .from('tips')
            .select('id, amount, currency, admin_tg_id')
            .or(`recipient_tg_id.eq.${userId},recipient_username.eq.${username}`)
            .eq('status', 'awaiting_claim')
            .is('batch_claim_id', null);

        if (tipError) throw tipError;

        if (!pendingTips || pendingTips.length < 2) {
            bot.sendMessage(chatId, 'You need at least 2 pending tips to use /claimall. Use /pendingclaims to check your tips, or /claimtip for a single tip.');
            return;
        }

        // Aggregate amounts by currency
        const aggregatedAmounts = {};
        const individualTipIds = pendingTips.map(tip => {
            const currencyKey = tip.currency.toLowerCase();
            aggregatedAmounts[currencyKey] = (aggregatedAmounts[currencyKey] || 0) + tip.amount;
            return tip.id;
        });
        // For simplicity, we'll assume a single currency batch for now.
        // If multiple currencies are present, this could get more complex for admin fulfillment.
        // For now, let's just make one batch for the first currency found.
        const firstCurrency = pendingTips[0].currency.toLowerCase();
        const totalAmount = aggregatedAmounts[firstCurrency];
        const adminIdOrigin = pendingTips[0].admin_tg_id; // Take the admin from the first tip

        // 1. Create a new batch_claim entry
        const { data: batchData, error: batchError } = await supabase
            .from('batch_claims')
            .insert({
                user_id: userId,
                username: username,
                first_name: msg.from.first_name, // first_name is used, should be escaped if markdown parsing issues persist
                total_amount: totalAmount,
                currency: firstCurrency, // Assuming one currency per batch for now
                status: 'awaiting_address',
                admin_tg_id_origin: adminIdOrigin
            })
            .select()
            .single();
        if (batchError) throw batchError;
        const newBatchId = batchData.id;

        // 2. Update all individual tips to link to this batch and change their status
        const { error: updateTipsError } = await supabase
            .from('tips')
            .update({
                batch_claim_id: newBatchId,
                status: 'part_of_batch_claim'
            })
            .in('id', individualTipIds);
        if (updateTipsError) throw updateTipsError;

        // 3. Set user state to await address for this batch
        const { error: stateError } = await supabase
            .from('user_states')
            .upsert(
                {
                    user_id: userId,
                    state: 'awaiting_batch_address',
                    context_id: newBatchId // Store the batch ID here
                },
                { onConflict: 'user_id' }
            );
        if (stateError) throw stateError;

        // --- NEW: Update prompt for /claimall to include /burn and /same as last time ---
        let replyMessage = `Great! You are claiming a total of ${formatCurrency(totalAmount, firstCurrency)} from ${pendingTips.length} tips.\n\n`;
        replyMessage += `Please reply to this message with:\n`;
        replyMessage += `  - A valid Taraxa EVM address (starting with \`0x...\`)\n`;
        replyMessage += `  - Or send \`/burn\` to burn your total tip\n`;
        replyMessage += `  - Or send \`/same as last time\` to use your previously saved address.\n\n`;
        replyMessage += `PU TO THE MOON 🗿🟢`;


        await bot.sendMessage(
            chatId,
            replyMessage,
            { parse_mode: 'Markdown' }
        );
        console.log(`User ${userId} initiated batch claim ${newBatchId}`);

    } catch (error) {
        console.error('Error initiating batch claim:', error.message);
        bot.sendMessage(chatId, 'An error occurred while processing your batch claim. Please try again later.');
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
            .eq('status', 'awaiting_claim')
            .is('batch_claim_id', null); // Ensure it's not part of a batch claim

        if (error) throw error;
        pendingTips = data;

        if (!pendingTips || pendingTips.length === 0) {
            const userNameDisplay = msg.from.first_name ? escapeMarkdown(msg.from.first_name) : 'there';
            bot.sendMessage(chatId, `Sorry ${userNameDisplay} - you've got no tips to claim YET.

Be an engaged community member in future to get tips!

Participate in X media raids, make memes, be active in the TG, make your own unique $chdpu posts on X. All of these could lead to more than just the tip ;)
https://x.com/ChadPuOfficial `);
            return;
        }

    } catch (error) {
        console.error('Error fetching pending tips:', error.message);
        bot.sendMessage(chatId, 'An error occurred while looking for your tips. Please try again later.');
        return;
    }

    const tipToClaim = pendingTips[0]; // Take the first available tip

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
                    state: 'awaiting_address_for_tip', // This state is for a single tip
                    context_id: tipToClaim.id
                },
                { onConflict: 'user_id' }
            );
        if (stateError) throw stateError;
        console.log(`User state set for ${userId} to awaiting_address_for_tip for tip ${tipToClaim.id}`);

        // --- NEW: Update prompt for /claimtip to include /burn and /same as last time ---
        let replyMessage = `Hey chad, you're claiming ${formatCurrency(tipToClaim.amount, tipToClaim.currency)}. \n\n`;
        replyMessage += `Please reply to this message with:\n`;
        replyMessage += `  - A valid Taraxa EVM address (starting with \`0x...\`)\n`;
        replyMessage += `  - Or send \`/burn\` to burn your total tip\n`;
        replyMessage += `  - Or send \`/same as last time\` to use your previously saved address.\n\n`;
        replyMessage += `PU TO THE MOON 🗿🟢`;

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


// Handle General Messages (for collecting addresses AND Admin Notification AND Activity Tracking)
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // --- Activity Tracking for Groups ---
    // Keep this section as it tracks active users for other potential uses
    // or for future features you might re-introduce that rely on it.
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const username = msg.from.username;
        const firstName = msg.from.first_name;
        const groupId = msg.chat.id;

        try {
            const { error } = await supabase
                .from('active_group_users')
                .upsert(
                    {
                        user_id: userId,
                        username: username ? username.toLowerCase() : null,
                        first_name: firstName,
                        group_id: groupId,
                        last_activity: new Date().toISOString()
                    },
                    { onConflict: ['user_id', 'group_id'] } // Composite primary key for upsert
                );

            if (error) {
                console.error(`Error updating active user for group ${groupId}:`, error.message);
            }
        } catch (err) {
            console.error('Unhandled error in active user tracking:', err.message);
        }
    }

    // --- Logic for collecting addresses in private chats ---
    if (msg.chat.type === 'private' && !msg.text.startsWith('/')) {
        try {
            const { data: userState, error } = await supabase
                .from('user_states')
                .select('*')
                .eq('user_id', userId)
                .single();
            if (error && error.code !== 'PGRST116') { // PGRST116 means "no rows found", which is expected if no state
                throw error;
            }

            if (userState) {
                let potentialAddress = msg.text.trim();

                // --- NEW: Handle /burn and /same as last time ---
                if (potentialAddress.toLowerCase() === '/burn') {
                    potentialAddress = CHDPU_BURN_ADDRESS;
                    await bot.sendMessage(chatId, 'You chose to burn your tip(s). Processing your request...');
                } else if (potentialAddress.toLowerCase() === '/same as last time') {
                    // Fetch last_claimed_address from active_group_users (or your dedicated user profiles table)
                    const { data: userData, error: userFetchError } = await supabase
                        .from('active_group_users') // Assuming active_group_users is where last_claimed_address is stored
                        .select('last_claimed_address')
                        .eq('user_id', userId)
                        .single();

                    if (userFetchError && userFetchError.code !== 'PGRST116') throw userFetchError;

                    if (userData && userData.last_claimed_address) {
                        potentialAddress = userData.last_claimed_address;
                        await bot.sendMessage(chatId, `Using your last claimed address: \`${potentialAddress}\``, {parse_mode: 'Markdown'});
                    } else {
                        await bot.sendMessage(chatId, 'You do not have a previously saved address. Please provide a valid Taraxa EVM address (starting with `0x...`) or send `/burn`.', {parse_mode: 'Markdown'});
                        return; // Stop processing, user needs to input address
                    }
                }

                const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(potentialAddress);

                if (!isValidAddress) {
                    await bot.sendMessage(msg.chat.id, 'That doesn\'t look like a valid Taraxa EVM address. Please try again. It should start with `0x` and be 42 characters long.', {parse_mode: 'Markdown'});
                    return; // Stop processing if address is invalid
                }

                if (userState.state === 'awaiting_address_for_tip') {
                    // --- Handle single tip claim ---
                    const tipId = userState.context_id;
                    const { data: tipDetails, error: fetchTipError } = await supabase
                        .from('tips')
                        .select('id, recipient_username, recipient_tg_id, amount, currency, admin_tg_id')
                        .eq('id', tipId)
                        .single();

                    if (fetchTipError) throw fetchTipError;
                    if (!tipDetails) throw new Error('Tip details not found for context_id');
                    const { error: tipUpdateError } = await supabase
                        .from('tips')
                        .update({
                            recipient_address: potentialAddress,
                            status: 'ready_for_admin_fulfillment'
                        })
                        .eq('id', tipId);
                    if (tipUpdateError) throw tipUpdateError;

                    const { error: stateClearError } = await supabase
                        .from('user_states')
                        .delete()
                        .eq('user_id', userId);
                    if (stateClearError) throw stateClearError;

                    console.log(`Address received from ${userId} for tip ${tipId}: ${potentialAddress}.`);
                    await bot.sendMessage(msg.chat.id, `Thank you! Your address has been received. The Chadmin will fulfill your request shortly.

Keep up the good work -

$chdpu to $1, $tara $10`);

                    // --- NEW: Update last_claimed_address for user ---
                    await supabase.from('active_group_users')
                        .upsert({ user_id: userId, last_claimed_address: potentialAddress }, { onConflict: 'user_id', ignoreDuplicates: false }) // Use ignoreDuplicates: false to always update
                        .then(({ error: upsertError }) => {
                            if (upsertError) console.error("Error upserting last_claimed_address:", upsertError.message);
                        });


                    // --- ADMIN NOTIFICATION for single tip ---
                    const adminNotificationMessage = `
💰 **NEW TIP READY FOR MANUAL FULFILLMENT!** 💰

Tip ID: \`${tipDetails.id}\`
Recipient: ${tipDetails.recipient_username || msg.from.username ? `@${escapeMarkdown(msg.from.username)}` : `TG ID: ${escapeMarkdown(String(userId))}`} (TG ID: ${escapeMarkdown(String(userId))})
Amount: ${formatCurrency(tipDetails.amount, tipDetails.currency)}
**Address: \`${potentialAddress}\`**

Please manually send this tip. Reply to this message with \`/done ${tipDetails.id} <transaction_hash>\` after sending.
                    `;
                    await bot.sendMessage(ADMIN_TELEGRAM_ID, adminNotificationMessage, { parse_mode: 'Markdown' });
                    console.log(`Admin notified for tip ${tipDetails.id} with all details.`);

                } else if (userState.state === 'awaiting_batch_address') {
                    // --- Handle batch claim ---
                    const batchId = userState.context_id;
                    // Update the batch_claims entry with the address and new status
                    const { data: batchUpdateData, error: batchUpdateError } = await supabase
                        .from('batch_claims')
                        .update({
                            recipient_address: potentialAddress,
                            status: 'ready_for_admin_fulfillment'
                        })
                        .eq('id', batchId)
                        .select()
                        .single();
                    if (batchUpdateError) throw batchUpdateError;
                    if (!batchUpdateData) throw new Error('Failed to update batch claim.');
                    // Clear user state
                    const { error: stateClearError } = await supabase
                        .from('user_states')
                        .delete()
                        .eq('user_id', userId);
                    if (stateClearError) throw stateClearError;

                    // Also update the status of individual tips belonging to this batch
                    const { error: individualTipsUpdateError } = await supabase
                        .from('tips')
                        .update({ status: 'ready_for_admin_fulfillment_batch' }) // New status to distinguish
                        .eq('batch_claim_id', batchId);
                    if (individualTipsUpdateError) throw individualTipsUpdateError;

                    console.log(`Address received from ${userId} for batch ${batchId}: ${potentialAddress}.`);
                    await bot.sendMessage(msg.chat.id, `Thank you! Your address has been received for your batch claim. The Chadmin will fulfill your request shortly.

Keep up the good work -

$chdpu to $1, $tara $10`);

                    // --- NEW: Update last_claimed_address for user ---
                    await supabase.from('active_group_users')
                        .upsert({ user_id: userId, last_claimed_address: potentialAddress }, { onConflict: 'user_id', ignoreDuplicates: false }) // Use ignoreDuplicates: false to always update
                        .then(({ error: upsertError }) => {
                            if (upsertError) console.error("Error upserting last_claimed_address:", upsertError.message);
                        });


                    // --- ADMIN NOTIFICATION for batch claim ---
                    const adminNotificationMessage = `
💰 **NEW BATCH CLAIM READY FOR MANUAL FULFILLMENT!** 💰

Batch ID: \`${batchUpdateData.id}\`
Recipient: ${batchUpdateData.username || msg.from.username ? `@${escapeMarkdown(msg.from.username)}` : `TG ID: ${escapeMarkdown(String(userId))}`} (TG ID: ${escapeMarkdown(String(userId))})
Total Amount: ${formatCurrency(batchUpdateData.total_amount, batchUpdateData.currency)}
**Address: \`${potentialAddress}\`**

Please manually send this *total* tip. Reply to this message with \`/donebatch ${batchUpdateData.id} <transaction_hash>\` after sending.
                    `;
                    await bot.sendMessage(ADMIN_TELEGRAM_ID, adminNotificationMessage, { parse_mode: 'Markdown' });
                    console.log(`Admin notified for batch claim ${batchUpdateData.id} with all details.`);

                }
            }
        } catch (err) {
            console.error('Error handling message for user state:', err.message);
            bot.sendMessage(msg.chat.id, 'An unexpected error occurred while processing your address. Please try again.');
        }
    }
});

// --- /done Command (Admin Only, for confirming individual tip fulfillment) ---
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
            .select('recipient_username, recipient_tg_id, amount, currency, recipient_address, status, batch_claim_id')
            .eq('id', tipId)
            .single();

        if (fetchError) throw fetchError;
        if (!tip) {
            bot.sendMessage(chatId, `Tip with ID \`${tipId}\` not found.`);
            return;
        }
        if (tip.batch_claim_id) {
            bot.sendMessage(chatId, `This tip (\`${tipId}\`) is part of a batch claim. Please use \`/donebatch ${tip.batch_claim_id} <tx_hash>\` instead.`);
            return;
        }
        if (tip.status === 'fulfilled') {
            bot.sendMessage(chatId, `Tip \`${tipId}\` is already fulfilled.`);
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
        let recipientDisplay = tip.recipient_username || (tip.recipient_tg_id ? `user with ID ${escapeMarkdown(String(tip.recipient_tg_id))}` : 'a user');
        let fulfillmentMessage = `
🎉 Your tip for ${formatCurrency(tip.amount, tip.currency)} has been sent!
🎉
Recipient: ${recipientDisplay}
        `;
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

        // --- NEW: Group Notification on Fulfillment (Individual Tip) ---
        let groupNotificationText;
        const isBurnFulfillment = tip.recipient_address && tip.recipient_address.toLowerCase() === CHDPU_BURN_ADDRESS.toLowerCase();

        if (tip.currency.toLowerCase() === 'chdpu') {
            groupNotificationText = formatChdpuForGroupNotification(tip.amount, tip.recipient_username, isBurnFulfillment);
        } else {
            // For TARA or other currencies, or if burned, use standard format
            if (isBurnFulfillment) {
                groupNotificationText = `@${escapeMarkdown(tip.recipient_username.replace('@', ''))} burned their tip ✅🔥`;
            } else {
                groupNotificationText = `@${escapeMarkdown(tip.recipient_username.replace('@', ''))} was tipped ${formatCurrency(tip.amount, tip.currency)} ✅`; // Kept ✅
            }
        }

        await bot.sendMessage(GROUP_NOTIFICATION_CHAT_ID, groupNotificationText, { parse_mode: 'Markdown' });

        // --- NEW: Separate /burn message for burn fulfillments ---
        if (isBurnFulfillment) {
            await bot.sendMessage(GROUP_NOTIFICATION_CHAT_ID, '/burn');
        }


    } catch (error) {
        console.error('Error handling /done command:', error.message);
        bot.sendMessage(chatId, `Failed to mark tip as fulfilled: ${error.message}`);
    }
});


// --- /donebatch Command (Admin Only, for confirming batch fulfillment) ---
bot.onText(/\/donebatch\s+([0-9a-fA-F-]+)\s*(0x[a-fA-F0-9]{64})?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    if (adminId !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, 'Sorry, only the admin can use the /donebatch command.');
        return;
    }

    const batchId = match[1];
    const txHash = match[2] || null; // Optional transaction hash

    try {
        // Fetch batch details
        const { data: batchClaim, error: fetchError } = await supabase
            .from('batch_claims')
            .select('id, user_id, username, first_name, total_amount, currency, recipient_address, status')
            .eq('id', batchId)
            .single();

        if (fetchError) throw fetchError;
        if (!batchClaim) {
            bot.sendMessage(chatId, `Batch claim with ID \`${batchId}\` not found.`);
            return;
        }
        if (batchClaim.status === 'fulfilled') {
            bot.sendMessage(chatId, `Batch claim \`${batchId}\` is already fulfilled.`);
            return;
        }

        // Update batch claim status to 'fulfilled'
        const { error: updateBatchError } = await supabase
            .from('batch_claims')
            .update({ status: 'fulfilled', tx_hash: txHash, fulfilled_at: new Date().toISOString() })
            .eq('id', batchId);
        if (updateBatchError) throw updateBatchError;

        // Also update all individual tips associated with this batch
        const { data: individualTips, error: updateTipsError } = await supabase
            .from('tips')
            .update({ status: 'fulfilled', tx_hash: txHash })
            .eq('batch_claim_id', batchId)
            .select('id, amount, currency');
        if (updateTipsError) throw updateTipsError;

        bot.sendMessage(chatId, `Batch claim \`${batchId}\` and all ${individualTips.length} associated tips marked as fulfilled.`);
        console.log(`Batch claim ${batchId} marked as fulfilled by admin. Tx Hash: ${txHash || 'N/A'}`);

        // Notify the recipient
        let recipientDisplay = batchClaim.username || batchClaim.first_name ? escapeMarkdown(batchClaim.first_name) : `user with ID ${escapeMarkdown(String(batchClaim.user_id))}`;
        let fulfillmentMessage = `
🎉 Your total tip for ${formatCurrency(batchClaim.total_amount, batchClaim.currency)} from your batch claim has been sent!
🎉
Recipient: ${recipientDisplay}
`;
        if (batchClaim.recipient_address && batchClaim.recipient_address.toLowerCase() === CHDPU_BURN_ADDRESS.toLowerCase()) {
            fulfillmentMessage += `\n(Note: This tip was sent to the burn address \`${CHDPU_BURN_ADDRESS}\` as per your request.)`;
        }
        if (txHash) {
            fulfillmentMessage += `\nTransaction: \`${txHash}\``;
        }
        fulfillmentMessage += `\nThis fulfilled ${individualTips.length} individual tips for you.`;
        // Try to notify the user directly
        if (batchClaim.user_id) {
            try {
                await bot.sendMessage(batchClaim.user_id, fulfillmentMessage, { parse_mode: 'Markdown' });
                console.log(`Notified recipient ${recipientDisplay} directly about batch fulfillment.`);
            } catch (dmError) {
                console.warn(`Could not DM recipient ${recipientDisplay} (${batchClaim.user_id}) about batch fulfillment. Error: ${dmError.message}. Recipient may need to start a DM with the bot first.`);
                bot.sendMessage(chatId, `Failed to DM recipient ${recipientDisplay}. They might need to start a DM with the bot first.`);
            }
        } else {
            console.warn(`No recipient TG ID for batch ${batchId}. Cannot notify recipient directly about fulfillment.`);
            bot.sendMessage(chatId, `Batch ${batchId} fulfilled, but cannot directly notify recipient as TG ID was not captured. They can check their wallet.`);
        }

        // --- NEW: Group Notification on Fulfillment (Batch Claim) ---
        let groupNotificationText;
        const isBurnFulfillment = batchClaim.recipient_address && batchClaim.recipient_address.toLowerCase() === CHDPU_BURN_ADDRESS.toLowerCase();

        if (batchClaim.currency.toLowerCase() === 'chdpu') {
            groupNotificationText = formatChdpuForGroupNotification(batchClaim.total_amount, batchClaim.username, isBurnFulfillment);
        } else {
            // For TARA or other currencies, or if burned, use standard format
            if (isBurnFulfillment) {
                groupNotificationText = `@${escapeMarkdown(batchClaim.username.replace('@', ''))} burned their tip ✅🔥`;
            } else {
                groupNotificationText = `@${escapeMarkdown(batchClaim.username.replace('@', ''))} was tipped ${formatCurrency(batchClaim.total_amount, batchClaim.currency)} ✅`; // Kept ✅
            }
        }

        await bot.sendMessage(GROUP_NOTIFICATION_CHAT_ID, groupNotificationText, { parse_mode: 'Markdown' });

        // --- NEW: Separate /burn message for burn fulfillments ---
        if (isBurnFulfillment) {
            await bot.sendMessage(GROUP_NOTIFICATION_CHAT_ID, '/burn');
        }


    } catch (error) {
        console.error('Error handling /donebatch command:', error.message);
        bot.sendMessage(chatId, `Failed to mark batch as fulfilled: ${error.message}`);
    }
});


// --- /stats command (Admin Only, in DM) ---
bot.onText(/\/stats/i, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    // 1. Admin verification
    if (adminId !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, 'Sorry, only the admin can use the /stats command.');
        return;
    }

    // Ensure it's used in a private chat for security/privacy
    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, 'Please use the /stats command in a private chat with me.');
        return;
    }

    try {
        // Count fulfilled individual tips
        const { count: fulfilledTipsCount, error: tipsError } = await supabase
            .from('tips')
            .select('id', { count: 'exact' })
            .eq('status', 'fulfilled')
            .is('batch_claim_id', null); // Count only individual fulfilled tips not part of a batch

        if (tipsError) throw tipsError;

        // Sum amounts of fulfilled individual tips
        const { data: fulfilledTipsAmounts, error: tipsAmountsError } = await supabase
            .from('tips')
            .select('amount, currency')
            .eq('status', 'fulfilled')
            .is('batch_claim_id', null);
        if (tipsAmountsError) throw tipsAmountsError;

        let totalTipsAmountCHDPU = 0;
        let totalTipsAmountTARA = 0;
        fulfilledTipsAmounts.forEach(tip => {
            if (tip.currency.toLowerCase() === 'chdpu') {
                totalTipsAmountCHDPU += tip.amount;
            } else if (tip.currency.toLowerCase() === 'tara') {
                totalTipsAmountTARA += tip.amount;
            }
        });
        // Count fulfilled batch claims
        const { count: fulfilledBatchesCount, error: batchesError } = await supabase
            .from('batch_claims')
            .select('id', { count: 'exact' })
            .eq('status', 'fulfilled');
        if (batchesError) throw batchesError;

        // Sum amounts of fulfilled batch claims
        const { data: fulfilledBatchesAmounts, error: batchesAmountsError } = await supabase
            .from('batch_claims')
            .select('total_amount, currency')
            .eq('status', 'fulfilled');
        if (batchesAmountsError) throw batchesAmountsError;

        let totalBatchesAmountCHDPU = 0;
        let totalBatchesAmountTARA = 0;
        fulfilledBatchesAmounts.forEach(batch => {
            if (batch.currency.toLowerCase() === 'chdpu') {
                totalBatchesAmountCHDPU += batch.total_amount;
            } else if (batch.currency.toLowerCase() === 'tara') {
                totalBatchesAmountTARA += batch.total_amount;
            }
        });
        // Combine totals
        const grandTotalTips = fulfilledTipsCount + fulfilledBatchesCount;
        // Counting individual fulfilled tips + fulfilled batch claims as single 'transactions'
        const grandTotalAmountCHDPU = totalTipsAmountCHDPU + totalBatchesAmountCHDPU;
        const grandTotalAmountTARA = totalBatchesAmountTARA; // Corrected to just use batch sum for TARA as individual tips are separate

        let statsMessage = `📊 **Bot Fulfillment Stats** 📊\n\n`;
        statsMessage += `Total fulfilled transactions (individual tips + batch claims): *${grandTotalTips}*\n\n`;
        if (grandTotalAmountCHDPU > 0) {
            statsMessage += `Total CHDPU sent: *${formatCurrency(grandTotalAmountCHDPU, 'CHDPU')}*\n`;
        }
        if (grandTotalAmountTARA > 0) {
            statsMessage += `Total TARA sent: *${formatCurrency(grandTotalAmountTARA, 'TARA')}*\n`;
        }
        statsMessage += `\n(Counts are for fully 'fulfilled' tips and batches.)`;
        await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error fetching stats:', error.message);
        bot.sendMessage(chatId, 'An error occurred while fetching stats. Please try again.');
    }
});

// IMPORTANT: Add this polling_error handler back for polling mode
bot.on('polling_error', (err) => console.error('Polling Error:', err.message));
console.log('Bot is running and listening for commands...');

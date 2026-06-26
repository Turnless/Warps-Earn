const ADMIN_SECRET_SIGNATURE = process.env.ADMIN_SECRET_SIGNATURE || 'fallback_secret_for_dev';
const PUBLIC_PAYOUT_CHANNEL_ID = process.env.PUBLIC_PAYOUT_CHANNEL_ID || '@WarpsEarn';

function escapeTelegramHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function getFormattedDateTime() {
    const optionsDate = { month: 'short', day: 'numeric', year: 'numeric' };
    const optionsTime = { hour: '2-digit', minute: '2-digit', hour12: true };
    const dateStr = new Date().toLocaleDateString('en-US', optionsDate);
    const timeStr = new Date().toLocaleTimeString('en-US', optionsTime);
    return `${dateStr} • ${timeStr}`;
}

const checkAdminAuth = (req, res, next) => {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    let cookieSecret = null;
    
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const match = cookies.find(c => c.startsWith('admin_token='));
        if (match) cookieSecret = match.split('=')[1];
    }
    
    if (secret === ADMIN_SECRET_SIGNATURE || cookieSecret === ADMIN_SECRET_SIGNATURE) {
        next();
    } else {
        res.status(401).send("Unauthorized: Invalid Admin Secret");
    }
};

module.exports = {
    ADMIN_SECRET_SIGNATURE,
    PUBLIC_PAYOUT_CHANNEL_ID,
    escapeTelegramHtml,
    getFormattedDateTime,
    checkAdminAuth
};

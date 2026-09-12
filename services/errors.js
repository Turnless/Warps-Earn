/**
 * Shared error classification.
 *
 * A backing-store outage (Redis quota exhausted, Atlas unreachable, a socket
 * reset) is not a bug in the user's request. It is transient and retryable, so
 * it should be reported as 503 with a message that says so — not as a 500 with
 * internal jargon, and never by echoing the driver's message to the client.
 */

const INFRASTRUCTURE_PATTERNS = /max requests limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|Redis|MongoNetwork|MongoServerSelection|MongoTimeout|Topology|connection .* closed|connection is closed|operation timed out|Stream isn't writeable|Connection is closed/i;

const OUTAGE_MESSAGE = "Service is temporarily unavailable. Please try again in a moment.";

/** True when the failure is the infrastructure, not the request. */
function isInfrastructureError(err) {
    if (!err) return false;
    const name = err.name || '';
    if (/^Mongo/.test(name) || name === 'MaxRetriesPerRequestError' || name === 'ReplyError') return true;
    return INFRASTRUCTURE_PATTERNS.test(err.message || '');
}

/**
 * Sends a route's error response, upgrading infrastructure failures to a 503
 * with an honest message and otherwise using the route's own wording.
 * Safe to call after a response has already been sent.
 */
function respondWithError(res, err, fallbackMessage, status = 500) {
    if (res.headersSent) return;
    if (isInfrastructureError(err)) {
        return res.status(503).json({ error: OUTAGE_MESSAGE });
    }
    return res.status(status).json({ error: fallbackMessage });
}

module.exports = { isInfrastructureError, respondWithError, OUTAGE_MESSAGE };

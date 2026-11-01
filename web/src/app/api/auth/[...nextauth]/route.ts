import {handlers} from "@/auth";
import {NextRequest, NextResponse} from "next/server";
import {checkRateLimit, getClientIp} from "@/lib/security/rate-limiter";

export const {GET} = handlers;

export async function POST(req: NextRequest) {
    if (req.nextUrl.pathname.includes('/callback/credentials') || req.nextUrl.pathname.includes('/signin')) {
        const ip = getClientIp(req);
        const rateLimit = await checkRateLimit(ip, {
            windowSeconds: 60,
            maxRequests: 10,
            prefix: 'auth_login_ip',
            failClosed: false,
        });

        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: 'Too many authentication attempts. Please try again later.' },
                {
                    status: 429,
                    headers: {
                        'Retry-After': String(rateLimit.resetSeconds),
                        'X-RateLimit-Limit': String(rateLimit.limit),
                        'X-RateLimit-Remaining': String(rateLimit.remaining),
                    },
                }
            );
        }
    }

    return handlers.POST(req);
}

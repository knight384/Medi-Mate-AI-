import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { HealthAlertService } from '@/lib/health-intelligence/alerts/alert-service';
import { readBoundedJson } from '@/lib/security/request-boundary';

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const reminders = await HealthAlertService.getReminders(userId);
  const preferences = HealthAlertService.getAlertPreferences(userId);

  return NextResponse.json({ reminders, preferences });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await readBoundedJson<{
      title: string;
      description?: string;
      category: 'MEDICATION_REMINDER' | 'MEASUREMENT_REMINDER' | 'ACTIVITY_GOAL' | 'APPOINTMENT';
      scheduleType: 'DAILY' | 'WEEKLY' | 'ONE_OFF';
      scheduleTime: string;
      metadata?: Record<string, unknown>;
    }>(req, { maxBytes: 16 * 1024 });

    const reminder = await HealthAlertService.createReminder({
      userId: session.user.id,
      title: body.title,
      description: body.description,
      category: body.category,
      scheduleType: body.scheduleType,
      scheduleTime: body.scheduleTime,
      metadata: body.metadata,
    });

    return NextResponse.json({ reminder });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await readBoundedJson<{
      reminderId?: string;
      isEnabled?: boolean;
      preferences?: {
        optInInformationalTrends?: boolean;
        quietHoursStart?: string;
        quietHoursEnd?: string;
        cooldownHours?: number;
      };
    }>(req, { maxBytes: 8 * 1024 });

    if (body.reminderId && typeof body.isEnabled === 'boolean') {
      const success = await HealthAlertService.toggleReminder(
        session.user.id,
        body.reminderId,
        body.isEnabled
      );
      return NextResponse.json({ success });
    }

    if (body.preferences) {
      const updated = HealthAlertService.updateAlertPreferences(
        session.user.id,
        body.preferences
      );
      return NextResponse.json({ preferences: updated });
    }

    return NextResponse.json({ error: 'Invalid update payload' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const reminderId = req.nextUrl.searchParams.get('id');
  if (!reminderId) {
    return NextResponse.json({ error: 'Missing reminder id' }, { status: 400 });
  }

  const success = await HealthAlertService.deleteReminder(session.user.id, reminderId);
  return NextResponse.json({ success });
}

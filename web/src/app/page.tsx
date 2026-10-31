import {redirect} from "next/navigation";
import {auth} from "@/auth";
import {withTenantContext} from "@/lib/db-tenant";
import {currentDeploymentEnv} from "@/lib/current-deployment-env";

export const dynamic = "force-dynamic";

export default async function Page() {
    const session = await auth()
    if (!session || !session.user || !session.user.id) redirect('/login');
    const userId = session.user.id;

    const { user, lastChatRoom } = await withTenantContext(userId, async (tx) => {
        const [user, lastChatRoom] = await Promise.all([
            tx.user.findUniqueOrThrow({
                select: {id: true, hasOnboarded: true},
                where: {id: userId}
            }),
            tx.chatRoom.findFirst({
                where: {authorId: userId},
                orderBy: {updatedAt: 'desc'},
            })
        ]);
        return { user, lastChatRoom };
    });

    // If user has not onboarded, redirect to onboarding
    if (!user.hasOnboarded) {
        if (currentDeploymentEnv === 'cloud') {
            redirect('/onboarding');
        } else {
            await withTenantContext(userId, async (tx) => {
                await tx.user.update({where: {id: userId}, data: {hasOnboarded: true}});
            });
        }
    }

    let chatRoom = lastChatRoom
    if (!lastChatRoom) {
        chatRoom = await withTenantContext(userId, async (tx) => {
            const assistantMode = await tx.assistantMode.findFirstOrThrow({where: {authorId: userId}})
            const llmProvider = await tx.lLMProvider.findFirstOrThrow({where: {authorId: userId}})
            return tx.chatRoom.create({
                data: {
                    name: 'Chat',
                    assistantModeId: assistantMode.id,
                    llmProviderId: llmProvider.id,
                    authorId: userId,
                }
            });
        });
    }
    if (chatRoom) redirect(`/chat/${chatRoom.id}`);
}

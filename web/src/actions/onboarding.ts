'use server';

import {PersonalInfoData} from "@/components/onboarding/PersonalInfo";
import {withTenantContext} from "@/lib/db-tenant";
import {auth} from "@/auth";

interface OnboardingSubmitRequest {
    symptoms: string;
    personalInfo: PersonalInfoData;
}

export async function onboardingSubmit(data: OnboardingSubmitRequest) {
    const session = await auth()
    const userId = session?.user?.id
    if (userId === undefined) throw new Error('User not found')

    return withTenantContext(userId, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({where: {id: userId}})
        const personalInfo = await tx.healthData.findFirst({
            where: {authorId: userId, type: 'PERSONAL_INFO'}
        })
        const personalInfoData = {
            name: '',
            height: {unit: data.personalInfo.heightUnit, value: data.personalInfo.height},
            weight: {unit: data.personalInfo.weightUnit, value: data.personalInfo.weight},
            birthDate: data.personalInfo.birthDate,
            gender: data.personalInfo.gender,
            ethnicity: data.personalInfo.ethnicity,
            country: data.personalInfo.country,
        }
        if (personalInfo === null) {
            await tx.healthData.create({
                data: {
                    type: 'PERSONAL_INFO',
                    authorId: userId,
                    data: personalInfoData,
                    createdAt: user.createdAt,
                    updatedAt: user.updatedAt
                }
            })
        } else {
            await tx.healthData.update({where: {id: personalInfo.id}, data: {data: personalInfoData}})
        }

        // Save symptoms
        await tx.healthData.create({
            data: {
                type: 'SYMPTOMS',
                authorId: userId,
                data: {description: data.symptoms}
            }
        })

        // Update onboarding status
        await tx.user.update({where: {id: userId}, data: {hasOnboarded: true}})

        // ChatRoom assistant modes 채팅 전부 생성
        const llmProvider = await tx.lLMProvider.findFirstOrThrow({where: {providerId: 'openai'}})
        const assistantModes = await tx.assistantMode.findMany({
            where: {
                OR: [
                    {authorId: userId, visibility: 'PRIVATE'},
                    {visibility: 'PUBLIC'},
                ],
                name: {in: ['Root Cause Analysis & Long Term Health.', 'Family Medicine', 'Best Doctor']}
            }
        })
        return tx.chatRoom.createManyAndReturn({
            data: assistantModes.map((mode) => {
                return {
                    name: 'New Chat',
                    authorId: userId,
                    assistantModeId: mode.id,
                    llmProviderId: llmProvider.id,
                    llmProviderModelId: 'o3-mini'
                }
            })
        })
    })
}

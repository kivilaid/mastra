'use client';

import {
  useExternalStoreRuntime,
  ThreadMessageLike,
  AppendMessage,
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  CompositeAttachmentAdapter,
  SimpleTextAttachmentAdapter,
} from '@assistant-ui/react';
import { useState, ReactNode, useEffect } from 'react';
import { RuntimeContext } from '@mastra/core/di';

import { ChatProps } from '@/types';

import { CoreUserMessage } from '@mastra/core';
import { fileToBase64 } from '@/lib/file';
import { useMastraClient } from '@/contexts/mastra-client-context';
import { PDFAttachmentAdapter } from '@/components/assistant-ui/attachments/pdfs-adapter';

const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => {
  return message;
};

const handleFinishReason = (finishReason: string) => {
  switch (finishReason) {
    case 'tool-calls':
      throw new Error('Stream finished with reason tool-calls, try increasing maxSteps');
    default:
      break;
  }
};

const convertToAIAttachments = async (attachments: AppendMessage['attachments']): Promise<Array<CoreUserMessage>> => {
  const promises = attachments
    .filter(attachment => attachment.type === 'image' || attachment.type === 'document')
    .map(async attachment => {
      if (attachment.type === 'document') {
        if (attachment.contentType === 'application/pdf') {
          // @ts-expect-error - TODO: fix this type issue somehow
          const pdfText = attachment.content?.[0]?.text || '';
          return {
            role: 'user' as const,
            content: [
              {
                type: 'file' as const,
                data: `data:application/pdf;base64,${pdfText}`,
                mimeType: attachment.contentType,
                filename: attachment.name,
              },
            ],
          };
        }

        return {
          role: 'user' as const,
          // @ts-expect-error - TODO: fix this type issue somehow
          content: attachment.content[0]?.text || '',
        };
      }

      return {
        role: 'user' as const,

        content: [
          {
            type: 'image' as const,
            image: await fileToBase64(attachment.file!),
            mimeType: attachment.file!.type,
          },
        ],
      };
    });

  return Promise.all(promises);
};

export function MastraRuntimeProvider({
  children,
  agentId,
  initialMessages,
  memory,
  threadId,
  refreshThreadList,
  settings,
  runtimeContext,
}: Readonly<{
  children: ReactNode;
}> &
  ChatProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | undefined>(threadId);

  const {
    frequencyPenalty,
    presencePenalty,
    maxRetries,
    maxSteps,
    maxTokens,
    temperature,
    topK,
    topP,
    instructions,
    chatWithGenerate,
  } = settings?.modelSettings ?? {};

  const runtimeContextInstance = new RuntimeContext();
  Object.entries(runtimeContext ?? {}).forEach(([key, value]) => {
    runtimeContextInstance.set(key, value);
  });

  useEffect(() => {
    const hasNewInitialMessages = initialMessages && initialMessages?.length > messages?.length;
    if (
      messages.length === 0 ||
      currentThreadId !== threadId ||
      (hasNewInitialMessages && currentThreadId === threadId)
    ) {
      if (initialMessages && threadId && memory) {
        const convertedMessages: ThreadMessageLike[] = initialMessages
          ?.map((message: any) => {
            const toolInvocationsAsContentParts = (message.toolInvocations || []).map((toolInvocation: any) => ({
              type: 'tool-call',
              toolCallId: toolInvocation?.toolCallId,
              toolName: toolInvocation?.toolName,
              args: toolInvocation?.args,
              result: toolInvocation?.result,
            }));

            const attachmentsAsContentParts = (message.experimental_attachments || []).map((image: any) => ({
              type: image.contentType.startsWith(`image/`)
                ? 'image'
                : image.contentType.startsWith(`audio/`)
                  ? 'audio'
                  : 'file',
              mimeType: image.contentType,
              image: image.url,
            }));

            return {
              ...message,
              content: [
                ...(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []),
                ...toolInvocationsAsContentParts,
                ...attachmentsAsContentParts,
              ],
            };
          })
          .filter(Boolean);
        setMessages(convertedMessages);
        setCurrentThreadId(threadId);
      }
    }
  }, [initialMessages, threadId, memory]);

  const mastra = useMastraClient();

  const agent = mastra.getAgent(agentId);

  const onNew = async (message: AppendMessage) => {
    if (message.content[0]?.type !== 'text') throw new Error('Only text messages are supported');

    const attachments = await convertToAIAttachments(message.attachments);

    const input = message.content[0].text;
    setMessages(currentConversation => [
      ...currentConversation,
      { role: 'user', content: input, attachments: message.attachments },
    ]);
    setIsRunning(true);

    try {
      if (chatWithGenerate) {
        const generateResponse = await agent.generate({
          messages: [
            {
              role: 'user',
              content: input,
            },
            ...attachments,
          ],
          runId: agentId,
          frequencyPenalty,
          presencePenalty,
          maxRetries,
          maxSteps,
          maxTokens,
          temperature,
          topK,
          topP,
          instructions,
          runtimeContext: runtimeContextInstance,
          ...(memory ? { threadId, resourceId: agentId } : {}),
        });
        if (generateResponse.response) {
          const latestMessage = generateResponse.response.messages.reduce(
            (acc, message) => {
              const _content = Array.isArray(acc.content) ? acc.content : [];
              if (typeof message.content === 'string') {
                return {
                  ...acc,
                  content: [
                    ..._content,
                    {
                      type: 'text',
                      text: message.content,
                    },
                  ],
                } as ThreadMessageLike;
              }
              if (message.role === 'assistant') {
                const toolCallContent = Array.isArray(message.content)
                  ? message.content.find(content => content.type === 'tool-call')
                  : undefined;

                if (toolCallContent) {
                  const newContent = _content.map(c => {
                    if (c.type === 'tool-call' && c.toolCallId === toolCallContent?.toolCallId) {
                      return { ...c, ...toolCallContent };
                    }
                    return c;
                  });

                  const containsToolCall = newContent.some(c => c.type === 'tool-call');
                  return {
                    ...acc,
                    content: containsToolCall ? newContent : [..._content, toolCallContent],
                  } as ThreadMessageLike;
                }

                const textContent = Array.isArray(message.content)
                  ? message.content.find(content => content.type === 'text' && content.text)
                  : undefined;

                if (textContent) {
                  return {
                    ...acc,
                    content: [..._content, textContent],
                  } as ThreadMessageLike;
                }
              }

              if (message.role === 'tool') {
                const toolResult = Array.isArray(message.content)
                  ? message.content.find(content => content.type === 'tool-result')
                  : undefined;

                if (toolResult) {
                  const newContent = _content.map(c => {
                    if (c.type === 'tool-call' && c.toolCallId === toolResult?.toolCallId) {
                      return { ...c, result: toolResult.result };
                    }
                    return c;
                  });
                  const containsToolCall = newContent.some(c => c.type === 'tool-call');

                  return {
                    ...acc,
                    content: containsToolCall
                      ? newContent
                      : [
                          ..._content,
                          { type: 'tool-result', toolCallId: toolResult.toolCallId, result: toolResult.result },
                        ],
                  } as ThreadMessageLike;
                }

                return {
                  ...acc,
                  content: [..._content, toolResult],
                } as ThreadMessageLike;
              }
              return acc;
            },
            { role: 'assistant', content: [] } as ThreadMessageLike,
          );
          setMessages(currentConversation => [...currentConversation, latestMessage]);
          handleFinishReason(generateResponse.finishReason);
        }
      } else {
        const response = await agent.stream({
          messages: [
            {
              role: 'user',
              content: input,
            },
            ...attachments,
          ],
          runId: agentId,
          frequencyPenalty,
          presencePenalty,
          maxRetries,
          maxSteps,
          maxTokens,
          temperature,
          topK,
          topP,
          instructions,
          runtimeContext: runtimeContextInstance,
          ...(memory ? { threadId, resourceId: agentId } : {}),
        });

        if (!response.body) {
          throw new Error('No response body');
        }

        let content = '';
        let assistantMessageAdded = false;
        let assistantToolCallAddedForUpdater = false;
        let assistantToolCallAddedForContent = false;

        function updater() {
          setMessages(currentConversation => {
            const message: ThreadMessageLike = {
              role: 'assistant',
              content: [{ type: 'text', text: content }],
            };

            if (!assistantMessageAdded) {
              assistantMessageAdded = true;
              if (assistantToolCallAddedForUpdater) {
                assistantToolCallAddedForUpdater = false;
              }
              return [...currentConversation, message];
            }

            if (assistantToolCallAddedForUpdater) {
              // add as new message item in messages array if tool call was added
              assistantToolCallAddedForUpdater = false;
              return [...currentConversation, message];
            }
            return [...currentConversation.slice(0, -1), message];
          });
        }

        await response.processDataStream({
          onTextPart(value) {
            if (assistantToolCallAddedForContent) {
              // start new content value to add as next message item in messages array
              assistantToolCallAddedForContent = false;
              content = value;
            } else {
              content += value;
            }
            updater();
          },
          async onToolCallPart(value) {
            // Update the messages state
            setMessages(currentConversation => {
              // Get the last message (should be the assistant's message)
              const lastMessage = currentConversation[currentConversation.length - 1];

              // Only process if the last message is from the assistant
              if (lastMessage && lastMessage.role === 'assistant') {
                // Create a new message with the tool call part
                const updatedMessage: ThreadMessageLike = {
                  ...lastMessage,
                  content: Array.isArray(lastMessage.content)
                    ? [
                        ...lastMessage.content,
                        {
                          type: 'tool-call',
                          toolCallId: value.toolCallId,
                          toolName: value.toolName,
                          args: value.args,
                        },
                      ]
                    : [
                        ...(typeof lastMessage.content === 'string'
                          ? [{ type: 'text', text: lastMessage.content }]
                          : []),
                        {
                          type: 'tool-call',
                          toolCallId: value.toolCallId,
                          toolName: value.toolName,
                          args: value.args,
                        },
                      ],
                };

                assistantToolCallAddedForUpdater = true;
                assistantToolCallAddedForContent = true;

                // Replace the last message with the updated one
                return [...currentConversation.slice(0, -1), updatedMessage];
              }

              // If there's no assistant message yet, create one
              const newMessage: ThreadMessageLike = {
                role: 'assistant',
                content: [
                  { type: 'text', text: content },
                  {
                    type: 'tool-call',
                    toolCallId: value.toolCallId,
                    toolName: value.toolName,
                    args: value.args,
                  },
                ],
              };
              assistantToolCallAddedForUpdater = true;
              assistantToolCallAddedForContent = true;
              return [...currentConversation, newMessage];
            });
          },
          async onToolResultPart(value: any) {
            // Update the messages state
            setMessages(currentConversation => {
              // Get the last message (should be the assistant's message)
              const lastMessage = currentConversation[currentConversation.length - 1];

              // Only process if the last message is from the assistant and has content array
              if (lastMessage && lastMessage.role === 'assistant' && Array.isArray(lastMessage.content)) {
                // Find the tool call content part that this result belongs to
                const updatedContent = lastMessage.content.map(part => {
                  if (typeof part === 'object' && part.type === 'tool-call' && part.toolCallId === value.toolCallId) {
                    return {
                      ...part,
                      result: value.result,
                    };
                  }
                  return part;
                });

                // Create a new message with the updated content
                const updatedMessage: ThreadMessageLike = {
                  ...lastMessage,
                  content: updatedContent,
                };
                // Replace the last message with the updated one
                return [...currentConversation.slice(0, -1), updatedMessage];
              }
              return currentConversation;
            });
          },
          onErrorPart(error) {
            throw new Error(error);
          },
          onFinishMessagePart({ finishReason }) {
            handleFinishReason(finishReason);
          },
        });
      }

      setIsRunning(false);
      setTimeout(() => {
        refreshThreadList?.();
      }, 500);
    } catch (error) {
      console.error('Error occurred in MastraRuntimeProvider', error);
      setIsRunning(false);
      setMessages(currentConversation => [
        ...currentConversation,
        { role: 'assistant', content: [{ type: 'text', text: `${error}` as string }] },
      ]);
    }
  };

  const runtime = useExternalStoreRuntime<any>({
    isRunning,
    messages,
    convertMessage,
    onNew,
    adapters: {
      attachments: new CompositeAttachmentAdapter([
        new SimpleImageAttachmentAdapter(),
        new SimpleTextAttachmentAdapter(),
        new PDFAttachmentAdapter(),
      ]),
    },
  });

  return <AssistantRuntimeProvider runtime={runtime}> {children} </AssistantRuntimeProvider>;
}

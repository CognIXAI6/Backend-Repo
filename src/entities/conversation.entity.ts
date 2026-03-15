// import {
//   Entity,
//   PrimaryGeneratedColumn,
//   Column,
//   CreateDateColumn,
//   UpdateDateColumn,
//   DeleteDateColumn,
//   OneToMany,
//   ManyToOne,
//   JoinColumn,
// } from 'typeorm';

// export enum ConversationMode {
//   SINGLE = 'single',
//   DOUBLE = 'double',
//   MULTI = 'multi',
// }

// export enum MessageRole {
//   USER = 'user',
//   ASSISTANT = 'assistant',
// }

// @Entity('conversation_messages')
// export class ConversationMessage {
//   @PrimaryGeneratedColumn('uuid')
//   id: string;

//   @Column({ name: 'conversation_id' })
//   conversationId: string;

//   @Column({ type: 'enum', enum: MessageRole })
//   role: MessageRole;

//   @Column({ type: 'text' })
//   content: string;

//   @Column({ type: 'text', nullable: true })
//   transcript: string | null;

//   @Column({ name: 'audio_url', nullable: true })
//   audioUrl: string | null;

//   @Column({ name: 'audio_duration_ms', nullable: true })
//   audioDurationMs: number | null;

//   @Column({ name: 'speaker_label', nullable: true })
//   speakerLabel: string | null;

//   @Column({ name: 'tokens_used', nullable: true })
//   tokensUsed: number | null;

//   @Column({ name: 'latency_ms', nullable: true })
//   latencyMs: number | null;

//   @CreateDateColumn({ name: 'created_at' })
//   createdAt: Date;

//   @ManyToOne(() => Conversation, (conv) => conv.messages, { onDelete: 'CASCADE' })
//   @JoinColumn({ name: 'conversation_id' })
//   conversation: Conversation;
// }

// @Entity('conversations')
// export class Conversation {
//   @PrimaryGeneratedColumn('uuid')
//   id: string;

//   @Column({ name: 'user_id' })
//   userId: string;

//   @Column({ nullable: true })
//   title: string | null;

//   @Column({ type: 'enum', enum: ConversationMode, default: ConversationMode.SINGLE })
//   mode: ConversationMode;

//   @Column({ name: 'field_id', nullable: true })
//   fieldId: string | null;

//   @Column({ name: 'total_messages', default: 0 })
//   totalMessages: number;

//   @Column({ name: 'last_activity_at', nullable: true })
//   lastActivityAt: Date | null;

//   @CreateDateColumn({ name: 'created_at' })
//   createdAt: Date;

//   @UpdateDateColumn({ name: 'updated_at' })
//   updatedAt: Date;

//   @DeleteDateColumn({ name: 'deleted_at' })
//   deletedAt: Date | null;

//   @OneToMany(() => ConversationMessage, (msg) => msg.conversation, { cascade: true })
//   messages: ConversationMessage[];
// }
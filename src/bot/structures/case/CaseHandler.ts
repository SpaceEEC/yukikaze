import { oneLine, stripIndents } from 'common-tags';
import { GuildMember, Message, MessageEmbed, TextChannel, User } from 'discord.js';
import { MoreThan, Repository } from 'typeorm';
import { Optional } from 'utility-types';
import YukikazeClient from '../../client/YukikazeClient';
import { Case } from '../../models/Cases';
import { SETTINGS } from '../../util/constants';

const ms = require('@naval-base/ms'); // eslint-disable-line

interface Footer {
	warn?: number;
	restriction?: number;
	mute?: number;
	kick?: number;
	ban?: number;
	[key: string]: number | undefined;
}

export const ACTION_KEYS = [
	'',
	'ban',
	'unban',
	'kick',
	'kick',
	'mute',
	'restriction',
	'restriction',
	'restriction',
	'warn',
	'restriction',
];

interface Log {
	member: GuildMember | User;
	action: string;
	caseNum: number;
	reason: string;
	message?: Pick<Message, 'author' | 'guild'>;
	duration?: number;
	ref?: number;
}

export default class CaseHandler {
	public cachedCases = new Set<string>();

	// eslint-disable-next-line no-useless-constructor
	public constructor(private readonly client: YukikazeClient, public repo: Repository<Case>) {}

	public async create(newCase: Optional<Omit<Case, 'id' | 'createdAt'>, 'action_processed'>) {
		return this.repo.insert({
			guild: newCase.guild,
			message: newCase.message,
			case_id: newCase.case_id,
			target_id: newCase.target_id,
			target_tag: newCase.target_tag,
			mod_id: newCase.mod_id,
			mod_tag: newCase.mod_tag,
			action: newCase.action,
			reason: newCase.reason,
		});
	}

	public async delete(message: Message, caseNum: number, removeRole?: boolean) {
		const cs = (await this.repo.findOne({ guild: message.guild!.id, case_id: caseNum })) as Case;

		const channel = this.client.settings.get<string>(message.guild!, SETTINGS.MOD_LOG, undefined);
		const restrictRoles = this.client.settings.get<{ EMBED: string; EMOJI: string; REACTION: string }>(
			message.guild!,
			SETTINGS.RESTRICT_ROLES,
			undefined,
		);
		const muteRole = this.client.settings.get<string>(message.guild!, SETTINGS.MUTE_ROLE, undefined);

		if (channel) {
			const chan = this.client.channels.get(channel) as TextChannel;
			try {
				const msgToDelete = await chan.messages.fetch(cs.message!);
				await msgToDelete.delete();
			} catch {}
			this.fix(cs.case_id, message.guild!.id, channel);
		}

		if ((restrictRoles || muteRole) && !removeRole) this.removeRoles(cs, message, restrictRoles, muteRole);
	}

	public async log({ member, action, caseNum, reason, message, duration, ref }: Log) {
		const embed = new MessageEmbed();
		if (message && message.author) {
			embed.setAuthor(`${message.author.tag} (${message.author.id})`, message.author.displayAvatarURL());
		}
		let reference;
		let channel;
		if (message && ref) {
			try {
				reference = await this.repo.findOne({ guild: message.guild!.id, case_id: ref });
				channel = this.client.settings.get<string>(message.guild!, SETTINGS.MOD_LOG, undefined);
			} catch {}
		}

		embed
			.setDescription(
				stripIndents`
				**Member:** ${member instanceof User ? member.tag : member.user.tag} (${member.id})
				**Action:** ${action}${action === 'Mute' && duration ? `\n**Length:** ${ms(duration, { long: true })}` : ''}
				**Reason:** ${reason}${
					reference
						? `\n**Ref case:** [${reference.case_id}](https://discordapp.com/channels/${reference.guild}/${channel}/${reference.message})`
						: ''
				}
			`,
			)
			.setThumbnail(member instanceof User ? member.displayAvatarURL() : member.user.displayAvatarURL())
			.setFooter(`Case ${caseNum}`)
			.setTimestamp(new Date());

		return embed;
	}

	public async history(member: GuildMember | User) {
		const cases = await this.repo.find({ target_id: member.id });
		const footer = cases.reduce((count: Footer, c) => {
			const action = ACTION_KEYS[c.action];
			count[action] = (count[action] || 0) + 1;
			return count;
		}, {});

		const colors = [8450847, 10870283, 13091073, 14917123, 16152591, 16667430, 16462404];
		const values = [footer.warn || 0, footer.restriction || 0, footer.mute || 0, footer.kick || 0, footer.ban || 0];
		const [warn, restriction, mute, kick, ban] = values;
		const colorIndex = Math.min(values.reduce((a: number, b: number): number => a + b), colors.length - 1);

		return new MessageEmbed()
			.setAuthor(
				`${member instanceof User ? member.tag : member.user.tag} (${member.id})`,
				member instanceof User ? member.displayAvatarURL() : member.user.displayAvatarURL(),
			)
			.setColor(colors[colorIndex])
			.setThumbnail(member instanceof User ? member.displayAvatarURL() : member.user.displayAvatarURL())
			.setFooter(oneLine`${warn} warning${warn > 1 || warn === 0 ? 's' : ''},
				${restriction} restriction${restriction > 1 || restriction === 0 ? 's' : ''},
				${mute} mute${mute > 1 || mute === 0 ? 's' : ''},
				${kick} kick${kick > 1 || kick === 0 ? 's' : ''},
				and ${ban} ban${ban > 1 || ban === 0 ? 's' : ''}.
			`);
	}

	private async removeRoles(
		cs: Case,
		message: Message,
		roles: { EMBED: string; EMOJI: string; REACTION: string },
		mute: string,
	) {
		switch (cs.action) {
			case 5:
				// eslint-disable-next-line no-case-declarations
				let member;
				try {
					member = await message.guild!.members.fetch(cs.target_id);
				} catch {
					break;
				}
				if (!member) break;
				// eslint-disable-next-line no-case-declarations
				const key = `${message.guild!.id}:${member.id}:MUTE`;
				try {
					this.cachedCases.add(key);
					await member.roles.remove(mute, `Mute removed by ${message.author!.tag} | Removed Case #${cs.case_id}`);
				} catch (error) {
					this.cachedCases.delete(key);
					message.reply(`there was an error removing the mute on this member: \`${error}\``);
				}
				break;
			case 6:
				try {
					let member;
					try {
						member = await message.guild!.members.fetch(cs.target_id);
					} catch {
						break;
					}
					if (!member) break;
					await member.roles.remove(
						roles.EMBED,
						`Embed restriction removed by ${message.author!.tag} | Removed Case #${cs.case_id}`,
					);
				} catch (error) {
					message.reply(`there was an error removing the embed restriction on this member: \`${error}\``);
				}
				break;
			case 7:
				try {
					let member;
					try {
						member = await message.guild!.members.fetch(cs.target_id);
					} catch {
						break;
					}
					if (!member) break;
					await member.roles.remove(
						roles.EMOJI,
						`Emoji restriction removed by ${message.author!.tag} | Removed Case #${cs.case_id}`,
					);
				} catch (error) {
					message.reply(`there was an error removing the emoji restriction on this member: \`${error}\``);
				}
				break;
			case 8:
				try {
					let member;
					try {
						member = await message.guild!.members.fetch(cs.target_id);
					} catch {
						break;
					}
					if (!member) break;
					await member.roles.remove(
						roles.REACTION,
						`Reaction restriction removed by ${message.author!.tag} | Removed Case #${cs.case_id}`,
					);
				} catch (error) {
					message.reply(`there was an error removing the reaction restriction on this member: \`${error}\``);
				}
				break;
			default:
				break;
		}
	}

	private async fix(caseNum: number, guild: string, channel: string) {
		const cases = await this.repo.find({ where: { guild, case_id: MoreThan(caseNum) }, order: { id: 'ASC' } });
		let newCaseNum = caseNum;

		for (const c of cases) {
			const chan = this.client.channels.get(channel) as TextChannel;
			try {
				const msg = await chan.messages.fetch(c.message!);
				await msg.edit({ embed: msg.embeds[0].setFooter(`Case ${newCaseNum}`) });
			} catch {}
			c.case_id = newCaseNum;
			await this.repo.save(c);
			newCaseNum++;
		}
	}
}
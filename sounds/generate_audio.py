import os
import json
import asyncio
import edge_tts
from pydub import AudioSegment
from pydub.generators import WhiteNoise
from pydub.silence import detect_nonsilent

# ==========================================
# 設定フラグ
# ==========================================
OUTPUT_DIRBASE = "edgetts"
LANGUAGE = ["ja", "en"]	# "ja" (日本語) または "en" (英語)
GENDER = ["male", "female"]  # "male" (男性) または "female" (女性)
APPLY_RADIO_EFFECT = True  # 無線ノイズ・帯域制限エフェクトの有無
APPLY_PA_ECHO_EFFECT = True # 屋外スピーカー風エコーの有無

# ==========================================
# ボイスモデルの定義 (Edge-TTS Neural Voices)
# ==========================================
VOICE_MAP = {
	"ja": {
		"female": "ja-JP-NanamiNeural",
		"male": "ja-JP-KeitaNeural"
	},
	"en": {
		"female": "en-US-AriaNeural",
		"male": "en-US-GuyNeural"
	}
}

# ==========================================
# フレーズ定義（英語）
# ==========================================
PHRASES_EN = {
	"num_0": "Zero", "num_1": "One", "num_2": "Two", "num_3": "Three",
	"num_4": "Four", "num_5": "Five", "num_6": "Six", "num_7": "Seven",
	"num_8": "Eight", "num_9": "Nine", "num_10": "Ten",
	"num_11": "Eleven", "num_12": "Twelve", "num_13": "Thirteen",
	"num_14": "Fourteen", "num_15": "Fifteen", "num_16": "Sixteen",
	"num_17": "Seventeen", "num_18": "Eighteen", "num_19": "Nineteen",
	"num_20": "Twenty", "num_30": "Thirty", "num_40": "Forty", "num_50": "Fifty",
	"num_60": "Sixty", "num_70": "Seventy", "num_80": "Eighty", "num_90": "Ninety",
	"hundred": "Hundred",

	"t_minus": "T-minus",
	"t_plus": "T-plus",
	"second": "Second",
	"seconds": "Seconds",
	"minute": "Minute",
	"minutes": "Minutes",
	"mark": "Mark",
	"and": "And",

	"ms_120": "T-minus two minutes",
	"ms_60": "T-minus one minute",
	"ms_30": "T-minus thirty seconds",
	"ms_20": "T-minus twenty seconds",
	"ms_15": "T-minus fifteen seconds",

	"ev_terminal_start": "Terminal countdown start",
	"ev_prop_loaded": "Propellant loading complete",
	"ev_chilldown": "Engine chilldown start",
	"ev_pressurize": "Tank pressurization start",
	"ev_weather_go": "Weather is go",
	"ev_range_go": "Range is go",
	"ev_ground_go": "Ground is go",
	"ev_avionics_go": "Avionics are go",
	"ev_propulsion_go": "Propulsion is go",
	"ev_guidance_go": "Guidance is go",
	"ev_flight_go": "Flight is go",
	"ev_ld_go": "Launch Director, we are go for launch",
	"ev_auto_seq": "Auto sequence start",
	"ev_internal_pwr": "Transfer to internal power",
	"ev_water_deluge": "Water deluge system on",
	"ev_rofi": "Sparkers active",
	"ev_main_engine": "Ignition sequence start",
	"ev_liftoff": "We have a liftoff",

	"fl_tower_clear": "Clear of the tower",
	"fl_pitch_roll": "Pitch and roll program active",
	"fl_pitch_downrange": "Vehicle is pitching downrange",
	"fl_traj_nominal": "Trajectory is nominal",
	"fl_telemetry_good": "Telemetry is looking good",
	"fl_approach_maxq": "Approaching Max-Q",
	"fl_meco": "Main engine cutoff"
}

# ==========================================
# フレーズ定義（日本語）
# ==========================================
PHRASES_JA = {
	"num_0": "ぜろ", "num_1": "いち", "num_2": "にい", "num_3": "さん",
	"num_4": "よん", "num_5": "ごお", "num_6": "ろく", "num_7": "なな",
	"num_8": "はち", "num_9": "きゅう", "num_10": "じゅう",
	"num_11": "じゅういち", "num_12": "じゅうに", "num_13": "じゅうさん",
	"num_14": "じゅうよん", "num_15": "じゅうご", "num_16": "じゅうろく",
	"num_17": "じゅうなな", "num_18": "じゅうはち", "num_19": "じゅうきゅう",
	"num_20": "にじゅう", "num_30": "さんじゅう", "num_40": "よんじゅう", "num_50": "ごじゅう",
	"num_60": "ろくじゅう", "num_70": "ななじゅう", "num_80": "はちじゅう", "num_90": "きゅうじゅう",
	"hundred": "ひゃく",

	"t_minus": "ティーマイナス",
	"t_plus": "ティープラス",
	"second": "びょう",
	"seconds": "びょう",
	"minute": "ふん",
	"minutes": "ふん",
	"mark": "マーク",
	"and": "と",

	"ms_120": "ティーマイナスにふん",
	"ms_60": "ティーマイナスいっぷん",
	"ms_30": "ティーマイナスさんじゅうびょう",
	"ms_20": "ティーマイナスにじゅうびょう",
	"ms_15": "ティーマイナスじゅうごびょう",

	"ev_terminal_start": "最終カウントダウン、開始",
	"ev_prop_loaded": "推進剤の充填、完了",
	"ev_chilldown": "エンジン冷却、開始",
	"ev_pressurize": "タンク加圧、開始",
	"ev_weather_go": "気象条件、ゴー",
	"ev_range_go": "しゃじょう系、ゴー",
	"ev_ground_go": "地上設備、ゴー",
	"ev_avionics_go": "アビオニクス、ゴー",
	"ev_propulsion_go": "推進系、ゴー",
	"ev_guidance_go": "誘導系、ゴー",
	"ev_flight_go": "飛行管制、ゴー",
	"ev_ld_go": "打ち上げが承認されました",
	"ev_auto_seq": "自動シーケンス、開始",
	"ev_internal_pwr": "内部電源に切り替わりました",
	"ev_water_deluge": "ウォーターカーテン散水、開始",
	"ev_rofi": "火工品トーチ点火",
	"ev_main_engine": "メインエンジンスタート",
	"ev_liftoff": "リフトオフ",

	"fl_tower_clear": "発射塔をクリアしました",
	"fl_pitch_roll": "ピッチロールプログラム、開始",
	"fl_pitch_downrange": "機体は計画軌道を飛行中",
	"fl_traj_nominal": "飛行軌道は正常です",
	"fl_telemetry_good": "テレメトリデータは良好です",
	"fl_approach_maxq": "マックスキューに到達",
	"fl_meco": "メインエンジン停止"
}

# ==========================================
# エフェクト処理関数
# ==========================================
def apply_radio_effect(audio):
	"""通信機風の帯域制限とホワイトノイズを適用"""
	processed = audio.high_pass_filter(300).low_pass_filter(3000)
	processed = (processed + 5) - 5
	noise = WhiteNoise().to_audio_segment(duration=len(processed)) - 30
	return processed.overlay(noise)

def apply_pa_echo(audio):
	"""屋外PAスピーカー風のディレイ（エコー）を適用"""
	echo1 = (audio - 6).low_pass_filter(2000)
	echo2 = (audio - 12).low_pass_filter(1000)
	
	silence = AudioSegment.silent(duration=len(audio) + 600)
	
	result = silence.overlay(audio, position=0)
	result = result.overlay(echo1, position=120)
	result = result.overlay(echo2, position=240)
	
	return result

# ==========================================
# 音声生成メイン処理
# ==========================================
async def generate_files(language, gender):
	dir = f"{OUTPUT_DIRBASE}_{language}_{gender}"
	os.makedirs(dir, exist_ok=True)
	manifest = []
	
	# 選択された言語と性別からボイスモデルを決定
	target_phrases = PHRASES_JA if language == "ja" else PHRASES_EN
	voice_model = VOICE_MAP[language][gender]
	
	print(f"Generating audio... (Language: {language}, Gender: {gender}, Voice: {voice_model})")
	print(f"Effects -> Radio: {APPLY_RADIO_EFFECT}, Echo: {APPLY_PA_ECHO_EFFECT}")
	
	for key, text in target_phrases.items():
		temp_mp3 = os.path.join(dir, f"temp_{key}.mp3")
		final_mp3 = os.path.join(dir, f"{key}.mp3")
		
		try:
			# 1. edge-ttsで一時MP3を出力
			communicate = edge_tts.Communicate(text, voice_model)
			await communicate.save(temp_mp3)
			
			# 2. pydubでMP3を読み込み、エフェクトを適用
			audio = AudioSegment.from_mp3(temp_mp3)

			# 最後の無音をカット
			nonsilent_ranges = detect_nonsilent(
				audio,
				min_silence_len=100,
				silence_thresh=-50
			)
			if nonsilent_ranges:
				last_end_trim = nonsilent_ranges[-1][1]
				audio = audio[:last_end_trim]
			
			if APPLY_RADIO_EFFECT:
				audio = apply_radio_effect(audio)
				
			if APPLY_PA_ECHO_EFFECT:
				audio = apply_pa_echo(audio)
			
			# 3. MP3として書き出し
			audio.export(final_mp3, format="mp3", bitrate="128k")
			manifest.append(key)
			print(f"  - Created {final_mp3}")
			
		except Exception as e:
			print(f"エラー発生 ({key}): {e}")
			
		finally:
			# 一時ファイルを削除
			if os.path.exists(temp_mp3):
				os.remove(temp_mp3)
	
	manifest_path = os.path.join(dir, "manifest.json")
	with open(manifest_path, 'w', encoding='utf-8') as f:
		json.dump(manifest, f, indent=4)
	
	print("Done!")

if __name__ == "__main__":
	for language in LANGUAGE:
		for gender in GENDER:
			asyncio.run(generate_files(language, gender))

terraform {
  required_providers {
    genesyscloud = {
      source  = "MyPureCloud/genesyscloud"
      version = "~> 1.84"
    }
  }
}

provider "genesyscloud" {}

resource "genesyscloud_routing_queue" "ADS_ProductLine_Automation_Terraform" {
  acw_timeout_ms   = 1000
  auto_answer_only = false
  media_settings_message {
    alerting_timeout_sec      = 30
    enable_auto_answer        = false
    enable_inactivity_timeout = false
    service_level_duration_ms = 20000
    service_level_percentage  = 0.8
  }
  scoring_method          = "TimestampAndPriority"
  last_agent_routing_mode = "AnyAgent"
  media_settings_callback {
    auto_end_delay_seconds    = 300
    enable_auto_dial_and_end  = false
    mode                      = "AgentFirst"
    alerting_timeout_sec      = 30
    enable_auto_answer        = false
    auto_dial_delay_seconds   = 300
    service_level_duration_ms = 20000
    service_level_percentage  = 0.8
  }
  name = "ADS_ProductLine_Automation_Terraform"
  media_settings_chat {
    alerting_timeout_sec      = 30
    enable_auto_answer        = false
    service_level_duration_ms = 20000
    service_level_percentage  = 0.8
  }
  skill_evaluation_method          = "BEST"
  suppress_in_queue_call_recording = true
  acw_wrapup_prompt                = "AGENT_REQUESTED"
  division_id                      = "2c89d550-2e9a-4395-934a-5d79d8af9d07"
  enable_manual_assignment         = false
  media_settings_email {
    alerting_timeout_sec      = 300
    enable_auto_answer        = false
    service_level_duration_ms = 86400000
    service_level_percentage  = 0.8
  }
  enable_audio_monitoring = false
  enable_transcription    = false
  media_settings_call {
    alerting_timeout_sec      = 30
    enable_auto_answer        = false
    service_level_duration_ms = 20000
    service_level_percentage  = 0.8
  }
  members {
    user_id  = "083af533-fc27-417b-9003-76cbb14910ab"
    ring_num = 1
  }
}

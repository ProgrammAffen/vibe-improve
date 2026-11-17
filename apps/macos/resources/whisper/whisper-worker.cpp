#include "whisper.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

int main(int argc, char **argv) {
    const bool useCpu = argc == 5 && std::string(argv[4]) == "--cpu";
    if (argc != 4 && !useCpu) {
        return 2;
    }

    // AVFoundation provides interleaved, mono 16 kHz signed 16-bit PCM.
    std::ifstream input(argv[2], std::ios::binary | std::ios::ate);
    const std::streamoff size = input.tellg();
    if (!input || size <= 0 || size > 8 * 1024 * 1024 || size % sizeof(int16_t) != 0) {
        return 2;
    }
    std::vector<int16_t> pcm(static_cast<size_t>(size) / sizeof(int16_t));
    input.seekg(0);
    if (!input.read(reinterpret_cast<char *>(pcm.data()), size)) {
        return 2;
    }
    std::vector<float> samples(pcm.size());
    std::transform(pcm.begin(), pcm.end(), samples.begin(), [](int16_t sample) { return sample / 32768.0f; });

    pid_t parent = getppid();
    if (parent <= 1) {
        return 3;
    }
    auto contextParams = whisper_context_default_params();
    contextParams.use_gpu = !useCpu;
    std::unique_ptr<whisper_context, decltype(&whisper_free)> context(
        whisper_init_from_file_with_params(argv[1], contextParams), whisper_free);
    if (!context) {
        return 3;
    }

    auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.language = argv[3];
    params.n_threads = static_cast<int>(std::clamp(std::thread::hardware_concurrency(), 1u, 6u));
    params.no_context = true;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_special = false;
    params.print_timestamps = false;
    params.suppress_nst = true;
    params.abort_callback = [](void *expectedParent) { return getppid() != *static_cast<pid_t *>(expectedParent); };
    params.abort_callback_user_data = &parent;
    if (whisper_full(context.get(), params, samples.data(), static_cast<int>(samples.size())) != 0) {
        return 3;
    }

    const int count = whisper_full_n_segments(context.get());
    for (int i = 0; i < count; ++i) {
        std::string text = whisper_full_get_segment_text(context.get(), i);
        for (char &character : text) {
            if (character == '\t' || character == '\n' || character == '\r') {
                character = ' ';
            }
        }
        std::cout << whisper_full_get_segment_t0(context.get(), i) * 10 << '\t'
                  << whisper_full_get_segment_t1(context.get(), i) * 10 << '\t' << text << '\n';
    }
    return std::cout ? 0 : 4;
}
